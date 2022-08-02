/**
 * @param {import('bull').Queue} queue
 * @param {import('@octokit/webhooks').Webhooks} webhooks
 */
export default function createWebhooksQueue (queue, webhooks) {
  /** @type {Map<string, (event: import('@octokit/webhooks').EmitterWebhookEvent) => (void | Promise<void>)>} */
  const eventHandlerMap = new Map()

  queue.process(async ({ data }) => {
    const eventHandler = eventHandlerMap.get(data.eventName)
    if (eventHandler) {
      await eventHandler(data.event)
    }
  })

  const webhookQueue = Object.freeze({
    /**
     * @template {import('@octokit/webhooks').EmitterWebhookEventName} TEventName
     * @param {TEventName} eventName
     * @param {(event: import('@octokit/webhooks').EmitterWebhookEvent<TEventName>) => (void | Promise<void>)} handler
     */
    on (eventName, handler) {
      // @ts-ignore
      eventHandlerMap.set(eventName, handler)
      webhooks.on(eventName, async event => {
        await queue.add({ eventName, event }, { removeOnComplete: true })
      })
      return webhookQueue
    }
  })
  return webhookQueue
}
