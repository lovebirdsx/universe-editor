/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/ipc/ipc.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  ChannelClient,
  ChannelServer,
  createChannelFromObject,
  InMemoryMessagePassingProtocol,
  IpcChannelDisposedError,
} from '../../ipc/ipc.js'
import { URI } from '../../base/uri.js'

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

describe('URI marshalling', () => {
  function pair() {
    const [clientProto, serverProto] = InMemoryMessagePassingProtocol.createPair()
    const server = new ChannelServer(serverProto)
    const client = new ChannelClient(clientProto)
    return { server, client, dispose: () => (client.dispose(), server.dispose()) }
  }

  it('revives a single URI return value to a real instance', async () => {
    const { server, client, dispose } = pair()
    const uri = URI.file('/tmp/foo.ts')
    server.registerChannel('r', createChannelFromObject({ get: () => uri }))
    const got = await client.getChannel('r').call<URI>('get')
    expect(got instanceof URI).toBe(true)
    expect(got.scheme).toBe('file')
    expect(got.fsPath).toBe(uri.fsPath)
    dispose()
  })

  it('revives URIs nested in objects and arrays, both directions', async () => {
    const { server, client, dispose } = pair()
    server.registerChannel('r', createChannelFromObject({ echo: (a: unknown) => a }))
    const payload = {
      one: URI.file('/a/b.ts'),
      list: [URI.parse('https://example.com/x?q=1#L2'), URI.file('/c/d.ts')],
      nested: { deep: URI.file('/e/f.ts') },
    }
    const got = await client.getChannel('r').call<typeof payload>('echo', payload)
    expect(got.one instanceof URI).toBe(true)
    expect(got.one.fsPath).toBe(payload.one.fsPath)
    expect(got.list.every((u) => u instanceof URI)).toBe(true)
    expect(got.list[1]!.fsPath).toBe(payload.list[1]!.fsPath)
    expect(got.nested.deep instanceof URI).toBe(true)
    // authority / query / fragment survive for non-file schemes.
    expect(got.list[0]!.scheme).toBe('https')
    expect(got.list[0]!.fragment).toBe('L2')
    dispose()
  })

  it('preserves URI authority (avoids the empty-path key collision)', async () => {
    const { server, client, dispose } = pair()
    const uri = URI.from({ scheme: 'file', authority: 'server', path: '/share' })
    server.registerChannel('r', createChannelFromObject({ get: () => uri }))
    const got = await client.getChannel('r').call<URI>('get')
    expect(got instanceof URI).toBe(true)
    expect(got.authority).toBe('server')
    expect(got.path).toBe('/share')
    dispose()
  })

  it('leaves a bare UriComponents object (no $mid) untouched', async () => {
    const { server, client, dispose } = pair()
    const bare = { scheme: 'file', path: '/x' } // legacy shape, no $mid stamp
    server.registerChannel('r', createChannelFromObject({ get: () => bare }))
    const got = await client.getChannel('r').call<Record<string, unknown>>('get')
    // Not revived to a real URI instance (isUri duck-types on shape, so check the class).
    expect(got instanceof URI).toBe(false)
    expect(got).toEqual(bare)
    dispose()
  })

  it('coexists with Uint8Array payloads in the same message', async () => {
    const { server, client, dispose } = pair()
    const bytes = new Uint8Array([1, 2, 3, 250])
    const uri = URI.file('/g/h.ts')
    server.registerChannel('r', createChannelFromObject({ echo: (a: unknown) => a }))
    const got = await client
      .getChannel('r')
      .call<{ uri: URI; data: Uint8Array }>('echo', { uri, data: bytes })
    expect(got.uri instanceof URI).toBe(true)
    expect(got.uri.fsPath).toBe(uri.fsPath)
    expect(got.data).toBeInstanceOf(Uint8Array)
    expect(Array.from(got.data)).toEqual(Array.from(bytes))
    dispose()
  })
})

describe('structured wire errors', () => {
  it('preserves error name and code across the wire', async () => {
    const [clientProto, serverProto] = InMemoryMessagePassingProtocol.createPair()
    const server = new ChannelServer(serverProto)
    const client = new ChannelClient(clientProto)

    server.registerChannel(
      'boom',
      createChannelFromObject({
        fail: () => {
          const err = new Error('stdin is not writable') as Error & { code?: string }
          err.name = 'AcpHostError'
          err.code = 'STDIN_NOT_WRITABLE'
          throw err
        },
      }),
    )

    const err = (await client
      .getChannel('boom')
      .call('fail')
      .catch((e: unknown) => e)) as Error & { code?: string }
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('AcpHostError')
    expect(err.message).toBe('stdin is not writable')
    expect(err.code).toBe('STDIN_NOT_WRITABLE')

    client.dispose()
    server.dispose()
  })

  it('channel-not-found error carries a name', async () => {
    const [clientProto, serverProto] = InMemoryMessagePassingProtocol.createPair()
    const server = new ChannelServer(serverProto)
    const client = new ChannelClient(clientProto)

    const err = (await client
      .getChannel('nope')
      .call('x')
      .catch((e: unknown) => e)) as Error
    expect(err.name).toBe('ChannelNotFoundError')
    expect(err.message).toMatch(/not found/)

    client.dispose()
    server.dispose()
  })
})

describe('ChannelClient.dispose rejects pending requests', () => {
  it('rejects an in-flight call with IpcChannelDisposedError', async () => {
    const [clientProto, serverProto] = InMemoryMessagePassingProtocol.createPair()
    const server = new ChannelServer(serverProto)
    const client = new ChannelClient(clientProto)

    // A channel whose handler never resolves — the call stays pending.
    server.registerChannel('slow', {
      call: () => new Promise<never>(() => {}),
      listen: () => {
        throw new Error('no events')
      },
    })

    const pending = client.getChannel('slow').call('wait')
    const assertion = expect(pending).rejects.toBeInstanceOf(IpcChannelDisposedError)
    client.dispose()
    await assertion

    server.dispose()
  })
})
