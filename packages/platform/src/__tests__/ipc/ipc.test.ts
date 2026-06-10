/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/ipc/ipc.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  ChannelClient,
  ChannelServer,
  createChannelFromObject,
  InMemoryMessagePassingProtocol,
} from '../../ipc/ipc.js'

async function flushMicrotasks(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) {
    await Promise.resolve()
  }
}

describe('InMemoryMessagePassingProtocol', () => {
  it('delivers messages from one side to the other', async () => {
    const [a, b] = InMemoryMessagePassingProtocol.createPair()
    const received: Uint8Array[] = []
    b.onMessage((data) => received.push(data))

    const msg = new TextEncoder().encode('hello')
    a.send(msg)
    await flushMicrotasks()

    expect(received).toHaveLength(1)
    expect(new TextDecoder().decode(received[0])).toBe('hello')
  })

  it('bidirectional communication works', async () => {
    const [a, b] = InMemoryMessagePassingProtocol.createPair()
    const fromA: string[] = []
    const fromB: string[] = []
    a.onMessage((d) => fromA.push(new TextDecoder().decode(d)))
    b.onMessage((d) => fromB.push(new TextDecoder().decode(d)))

    a.send(new TextEncoder().encode('ping'))
    b.send(new TextEncoder().encode('pong'))
    await flushMicrotasks()

    expect(fromB).toContain('ping')
    expect(fromA).toContain('pong')
  })

  it('disconnect() stops delivering messages', async () => {
    const [a, b] = InMemoryMessagePassingProtocol.createPair()
    const received: unknown[] = []
    b.onMessage(() => received.push(1))

    a.disconnect()
    a.send(new TextEncoder().encode('nope'))
    await flushMicrotasks()

    expect(received).toHaveLength(0)
  })
})

describe('ChannelClient / ChannelServer', () => {
  it('client can call a server command and get a response', async () => {
    const [clientProto, serverProto] = InMemoryMessagePassingProtocol.createPair()

    const server = new ChannelServer(serverProto)
    const client = new ChannelClient(clientProto)

    server.registerChannel(
      'math',
      createChannelFromObject({
        add: (arg: unknown) => {
          const { a, b } = arg as { a: number; b: number }
          return a + b
        },
      }),
    )

    const ch = client.getChannel('math')
    const result = await ch.call<number>('add', { a: 3, b: 4 })
    await flushMicrotasks()
    expect(result).toBe(7)

    client.dispose()
    server.dispose()
  })

  it('round-trips Uint8Array payloads through the JSON envelope', async () => {
    const [clientProto, serverProto] = InMemoryMessagePassingProtocol.createPair()

    const server = new ChannelServer(serverProto)
    const client = new ChannelClient(clientProto)

    const bytes = new Uint8Array([0, 35, 32, 71, 250, 0, 13, 10])
    server.registerChannel(
      'fs',
      createChannelFromObject({
        read: () => bytes,
        echo: (arg: unknown) => arg,
      }),
    )

    const ch = client.getChannel('fs')
    const read = await ch.call<Uint8Array>('read')
    expect(read).toBeInstanceOf(Uint8Array)
    expect(Array.from(read)).toEqual(Array.from(bytes))

    // Also survives nested in an argument, in both directions.
    const echoed = await ch.call<{ data: Uint8Array }>('echo', { data: bytes })
    expect(echoed.data).toBeInstanceOf(Uint8Array)
    expect(Array.from(echoed.data)).toEqual(Array.from(bytes))

    client.dispose()
    server.dispose()
  })

  it('errors from server are propagated to client as rejected promises', async () => {
    const [clientProto, serverProto] = InMemoryMessagePassingProtocol.createPair()

    const server = new ChannelServer(serverProto)
    const client = new ChannelClient(clientProto)

    server.registerChannel(
      'boom',
      createChannelFromObject({
        fail: () => {
          throw new Error('intentional error')
        },
      }),
    )

    const ch = client.getChannel('boom')
    await expect(ch.call('fail')).rejects.toThrow('intentional error')

    client.dispose()
    server.dispose()
  })

  it('unknown channel returns an error', async () => {
    const [clientProto, serverProto] = InMemoryMessagePassingProtocol.createPair()

    const server = new ChannelServer(serverProto)
    const client = new ChannelClient(clientProto)

    const ch = client.getChannel('does-not-exist')
    await expect(ch.call('anything')).rejects.toThrow("Channel 'does-not-exist' not found")

    client.dispose()
    server.dispose()
  })
})

describe('createChannelFromObject', () => {
  it('resolves known commands', async () => {
    const ch = createChannelFromObject({ greet: (name: unknown) => `Hello, ${name}!` })
    const result = await ch.call<string>('greet', 'World')
    expect(result).toBe('Hello, World!')
  })

  it('rejects unknown commands', async () => {
    const ch = createChannelFromObject({})
    await expect(ch.call('unknown')).rejects.toThrow('Unknown command: unknown')
  })
})
