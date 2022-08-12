import PQueue from 'p-queue'

/**
 * @param {import('@octokit/webhooks').Webhooks} webhooks
 */
export default function createWebhooksQueue (webhooks) {
  const queue = new PQueue({ concurrency: 1 })

  const webhookQueue = Object.freeze({
    /**
     * @template {import('@octokit/webhooks').EmitterWebhookEventName} TEventName
     * @param {TEventName} eventName
     * @param {(event: import('@octokit/webhooks').EmitterWebhookEvent<TEventName>) => (void | Promise<void>)} handler
     */
    on (eventName, handler) {
      // @ts-ignore
      webhooks.on(eventName, async event => {
        await queue.add(async () => {
          return Promise.resolve().then(() => handler(event)).catch(error => {
            console.error({ err: error }, `Error in ${eventName} handler`)
          })
        })
      })
      return webhookQueue
    },
    async onEmpty () {
      return queue.onEmpty()
    }
  })
  return webhookQueue
}
