import 'dotenv/config'
import process from 'node:process'
import { z } from 'zod'

const configSchema = z.object({
  port: z.number(),
  githubWebhookSecret: z.string().trim().min(10),
  githubToken: z.string(),
  slackBotToken: z.string(),
  slackChannelId: z.string(),
  redisURL: z.string()
})

const envSchema = z
  .object({
    PORT: z.string().default('3000'),
    GITHUB_WEBHOOK_SECRET: z.string(),
    GITHUB_TOKEN: z.string(),
    SLACK_BOT_TOKEN: z.string(),
    SLACK_CHANNEL_ID: z.string(),
    REDIS_URL: z.string()
  })
  .transform(env =>
    configSchema.parse({
      port: Number.parseInt(env.PORT, 10),
      githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET,
      githubToken: env.GITHUB_TOKEN,
      slackBotToken: env.SLACK_BOT_TOKEN,
      slackChannelId: env.SLACK_CHANNEL_ID,
      redisURL: env.REDIS_URL
    })
  )

export default envSchema.parse(process.env)
