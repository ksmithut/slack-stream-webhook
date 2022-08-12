import { Octokit } from '@octokit/rest'
import { createNodeMiddleware, Webhooks } from '@octokit/webhooks'
import { LogLevel, WebClient } from '@slack/web-api'
import yaml from 'js-yaml'
import http from 'node:http'
import { promisify } from 'node:util'
import { z } from 'zod'
import config from './config.js'
import createTypedLRUCache from './lru.js'
import createWebhooksQueue from './webhooks-queue.js'

const webhooks = new Webhooks({ secret: config.githubWebhookSecret })
const octokit = new Octokit({ auth: config.githubToken })
const webhookQueue = createWebhooksQueue(webhooks)
const slack = new WebClient(config.slackBotToken, { logLevel: LogLevel.ERROR })

const messageInfoSchema = z.object({ channel: z.string(), ts: z.string() })
const cache = createTypedLRUCache(messageInfoSchema)

webhookQueue.on('workflow_job.queued', async event => {
  const { workflow_job: job, repository, sender } = event.payload
  const messageInfo = await getMessageInfo(job.run_id, job.run_attempt)
  if (!messageInfo) {
    const run = await getWorkflowRunFromWorkflowJob(job, repository)
    if (!run) return
    const { channel, ts } = await slack.chat.postMessage({
      channel: config.slackChannelId,
      unfurl_links: false,
      unfurl_media: false,
      attachments: [{
        color: getRunColor(),
        blocks: [
          // @ts-ignore
          getInfoBlock(run, repository, sender),
          getJobBlock(job)
        ]
      }]
    })
    if (!ts || !channel) return
    await setMessageInfo(job.run_id, job.run_attempt, { channel, ts })
    return
  }
  await updateMessageFromWorkflowJob(messageInfo, job)
})

webhookQueue.on('workflow_job.in_progress', async event => {
  const { workflow_job: job } = event.payload
  const messageInfo = await getMessageInfo(job.run_id, job.run_attempt)
  if (!messageInfo) return
  await updateMessageFromWorkflowJob(messageInfo, job)
})

webhookQueue.on('workflow_job.completed', async event => {
  const { workflow_job: job } = event.payload
  const messageInfo = await getMessageInfo(job.run_id, job.run_attempt)
  if (!messageInfo) return
  await updateMessageFromWorkflowJob(messageInfo, job)
  await slack.chat.postMessage({
    channel: messageInfo.channel,
    thread_ts: messageInfo.ts,
    text: `${job.name} ${job.conclusion}`,
    unfurl_links: false,
    unfurl_media: false,
    blocks: [getJobBlock(job)]
  })
})

webhookQueue.on('workflow_run.completed', async event => {
  const { workflow_run: run } = event.payload
  const messageInfo = await getMessageInfo(run.id, run.run_attempt)
  if (!messageInfo) return
  const message = await getMessageFromMessageInfo(messageInfo)
  if (!message) return
  const color = getRunColor(run)
  await slack.chat.update({
    channel: messageInfo.channel,
    ts: messageInfo.ts,
    unfurl_links: false,
    unfurl_media: false,
    // @ts-ignore
    attachments: [{ color, blocks: message.attachments?.[0].blocks ?? [] }]
  })
  await slack.chat.postMessage({
    channel: messageInfo.channel,
    thread_ts: messageInfo.ts,
    unfurl_links: false,
    unfurl_media: false,
    attachments: [{
      color,
      blocks: [{
        type: 'header',
        text: { type: 'plain_text', text: `${run.name} ${run.conclusion}` }
      }]
    }]
  })
})

/** @typedef {import('@octokit/webhooks-types/schema').WorkflowJob} WorkflowJob */
/** @typedef {import('@octokit/webhooks-types/schema').WorkflowRun} WorkflowRun */
/** @typedef {import('@octokit/webhooks-types/schema').Repository} Repository */
/** @typedef {import('@octokit/webhooks-types/schema').User} User */
/** @typedef {import('zod').infer<typeof messageInfoSchema>} MessageInfo */

/**
 * @param {number} runId
 * @param {number} runAttempt
 */
async function getMessageInfo (runId, runAttempt) {
  return cache.get(`${runId}:${runAttempt}`) ?? null
}

/**
 * @param {number} runId
 * @param {number} runAttempt
 * @param {MessageInfo} messageInfo
 */
async function setMessageInfo (runId, runAttempt, messageInfo) {
  cache.set(`${runId}:${runAttempt}`, {
    channel: messageInfo.channel,
    ts: messageInfo.ts
  })
}

/**
 * @param {MessageInfo} messageInfo
 */
async function getMessageFromMessageInfo (messageInfo) {
  const history = await slack.conversations.history({
    channel: messageInfo.channel,
    latest: messageInfo.ts,
    limit: 1,
    inclusive: true
  })
  return history.messages?.at(0) ?? null
}

const workflowYamlSchema = z.object({ env: z.record(z.any()).optional() })

/**
 * @param {WorkflowJob} job
 * @param {Repository} repository
 */
async function getWorkflowRunFromWorkflowJob (job, repository) {
  const owner = repository.organization ?? repository.owner.login
  const repo = repository.name
  const { data: run } = await octokit.actions.getWorkflowRunAttempt({
    owner,
    repo,
    run_id: job.run_id,
    attempt_number: job.run_attempt
  })
  const { data: content } = await octokit.repos.getContent({
    owner,
    repo,
    path: run.path,
    ref: run.head_sha
  })
  if (Array.isArray(content)) return null
  if (content.type !== 'file') return null
  if (!('encoding' in content)) return null
  if (content.encoding === 'base64') {
    const rawContents = Buffer.from(content.content, 'base64').toString()
    const parsedContents = workflowYamlSchema.parse(yaml.load(rawContents))
    if (parsedContents.env?.SLACK_STREAM !== true) return null
    return run
  }
  return null
}

/**
 * @param {MessageInfo} messageInfo
 * @param {WorkflowJob} job
 */
async function updateMessageFromWorkflowJob (messageInfo, job) {
  const message = await getMessageFromMessageInfo(messageInfo)
  if (!message) return
  await slack.chat.update({
    channel: messageInfo.channel,
    ts: messageInfo.ts,
    unfurl_links: false,
    unfurl_media: false,
    attachments: [{
      color: '#DBAB0A',
      // @ts-ignore
      blocks: upsertJob(message.attachments[0].blocks ?? [], job)
    }]
  })
}

/**
 * @param {WorkflowRun} run
 * @param {Repository} repo
 * @param {User} sender
 */
export function getInfoBlock (run, repo, sender) {
  const info = [
    { label: 'Repo', url: repo.html_url, value: repo.full_name },
    ...run.pull_requests.map(pullRequest => ({
      label: 'PR',
      url: `${repo.html_url}/pull/${encodeURIComponent(pullRequest.number)}`,
      value: `#${pullRequest.number}`
    })),
    { label: 'Workflow', url: run.html_url, value: run.name }
  ]
  if (run.run_attempt > 1) {
    info.push({
      label: 'Attempt',
      url: `${run.html_url}/attempts/${encodeURIComponent(run.run_attempt)}`,
      value: `#${run.run_attempt}`
    })
  }
  info.push({ label: 'Author', url: sender.html_url, value: sender.login })
  return {
    block_id: 'info',
    type: 'section',
    fields: info.map(item => ({
      type: 'mrkdwn',
      text: `*${item.label}*\n<${item.url}|${item.value}>`
    }))
  }
}

/**
 * @param {WorkflowJob} job
 */
export function getJobBlock (job) {
  return {
    block_id: 'jobs0',
    type: 'context',
    elements: [{ type: 'mrkdwn', text: getJobText(job) }]
  }
}

/**
 * @param {import('@slack/web-api').ContextBlock[]} blocks
 * @param {WorkflowJob} job
 */
export function upsertJob (blocks, job) {
  const [jobsBlocks, otherBlocks] = partition(
    blocks,
    block => block.block_id?.startsWith('jobs')
  )
  let updated = false
  const jobElement = { type: 'mrkdwn', text: getJobText(job) }
  const elements = jobsBlocks.flatMap(block => block.elements).map(element => {
    if (element.type !== 'mrkdwn') return element
    if (!element.text.includes(`<${job.html_url}|`)) return element
    updated = true
    if (element.text.match(/:slack-stream-(success|failure|cancelled):/)) {
      return element
    }
    return jobElement
  })
  if (!updated) elements.push(jobElement)
  return [
    ...otherBlocks,
    ...chunkEvery(elements, 10).map((elements, i) => ({
      block_id: `jobs${i}`,
      type: 'context',
      elements: elements
    }))
  ]
}

/**
 * @param {WorkflowJob} job
 */
function getJobText (job) {
  const emoji = getJobEmoji(job)
  const completionTime = getCompletionTime(job)
  const suffix = completionTime ? ` (${completionTime})` : ''
  return `:${emoji}: <${job.html_url}|${job.name}>${suffix}`
}

/**
 * @param {WorkflowJob} job
 */
function getJobEmoji (job) {
  if (job.status === 'queued') return 'slack-stream-pending'
  if (job.status === 'in_progress') return 'slack-stream-running'
  if (job.status === 'completed') {
    if (job.conclusion === 'success') return 'slack-stream-success'
    if (job.conclusion === 'failure') return 'slack-stream-failure'
    if (job.conclusion === 'cancelled') return 'slack-stream-cancelled'
  }
  throw new Error(
    `unknown status: ${job.status}, conclusion: ${job.conclusion}`
  )
}

/**
 * @param {WorkflowJob} job
 */
function getCompletionTime (job) {
  if (!job.completed_at) return null
  const completedAt = new Date(job.completed_at)
  const startedAt = new Date(job.started_at)
  const durationMs = completedAt.getTime() - startedAt.getTime()
  const durationSeconds = Math.floor(durationMs / 1000)
  const minutes = Math.floor(durationSeconds / 60)
  const seconds = durationSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * @param {WorkflowRun} [run]
 */
export function getRunColor (run) {
  if (!run) return '#768390'
  switch (run.conclusion) {
    case 'cancelled':
      return '#767172'
    case 'success':
      return '#57AB5A'
    case 'failure':
      return '#E5534B'
    default:
      return '#768390'
  }
}

/**
 * @template T
 * @param {T[]} list
 * @param {number} count
 * @returns {T[][]}
 */
export function chunkEvery (list, count) {
  /** @type {T[][]} */
  const chunks = []
  for (let i = 0; i < list.length; i += count) {
    chunks.push(list.slice(i, i + count))
  }
  return chunks
}

/**
 * @template T
 * @param {T[]} list
 * @param {(item: T) => any} partitionBy
 * @returns {[T[], T[]]}
 */
export function partition (list, partitionBy) {
  /** @type {T[]} */
  const left = []
  /** @type {T[]} */
  const right = []
  for (const item of list) {
    if (partitionBy(item)) left.push(item)
    else right.push(item)
  }
  return [left, right]
}

const webhookMiddleware = createNodeMiddleware(webhooks, { path: '/' })

const server = http
  .createServer((req, res) => {
    if (req.method === 'POST') return webhookMiddleware(req, res)
    res.end('ok')
  })
  .listen(config.port)
  .on('listening', () => {
    console.log(`Webhook server listening on port ${config.port}`)
  })

async function stop () {
  await promisify(server.close.bind(server))()
  await webhookQueue.onEmpty()
}

let called = false
function shutdown () {
  if (called) return
  called = true
  stop().then(() => process.exit()).catch(err => {
    console.error(err)
    process.exit(1)
  })
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
process.once('SIGUSR2', shutdown)
