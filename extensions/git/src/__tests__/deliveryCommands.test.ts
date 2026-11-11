import { describe, expect, it } from 'vitest'
import { registerDeliveryCommands } from '../delivery/deliveryCommands.js'

describe('delivery command registration', () => {
  it('turns a thrown handler into a git_failed result', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerDeliveryCommands((id, handler) => {
      handlers.set(id, handler)
      return { dispose: () => undefined }
    })

    // `undefined` makes preparePickDelivery throw on its first property read;
    // the proxy must receive a result instead of a rejected promise.
    const result = await handlers.get('git.agentDelivery.preparePick')?.(undefined)

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'git_failed',
        message: "git delivery command 'preparePick' failed",
        detail: expect.any(String),
      },
    })
  })
})
