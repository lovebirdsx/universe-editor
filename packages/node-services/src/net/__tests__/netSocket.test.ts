/*---------------------------------------------------------------------------------------------
 *  Tests for packages/node-services/src/net/netSocket.ts
 *--------------------------------------------------------------------------------------------*/

import { createServer, type AddressInfo, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { readFirstControlFrame, type SocketCloseEvent } from '@universe-editor/platform'
import { connectNodeSocket, NodeSocket } from '../netSocket.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const servers: Server[] = []
const sockets: NodeSocket[] = []

afterEach(async () => {
  for (const socket of sockets) {
    socket.dispose()
  }
  sockets.length = 0
  for (const server of servers) {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
  servers.length = 0
})

async function openPair(): Promise<{ server: Server; client: NodeSocket; serverSide: NodeSocket }> {
  const server = createServer()
  servers.push(server)

  const serverSidePromise = new Promise<NodeSocket>((resolve) => {
    server.once('connection', (socket) => {
      const serverSide = new NodeSocket(socket)
      sockets.push(serverSide)
      resolve(serverSide)
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const port = (server.address() as AddressInfo).port
  const client = await connectNodeSocket(port)
  sockets.push(client)

  const serverSide = await serverSidePromise
  return { server, client, serverSide }
}

describe('NodeSocket', () => {
  it('round-trips multiple chunks in both directions preserving order', async () => {
    const { client, serverSide } = await openPair()

    const toServer = [Buffer.from('a'), Buffer.from('bb'), Buffer.from('ccc')]
    const toClient = [Buffer.from('1'), Buffer.from('22'), Buffer.from('333')]
    const toServerBytes = Buffer.concat(toServer)
    const toClientBytes = Buffer.concat(toClient)

    const clientReceivedAll = deferred<void>()
    let serverReceived = Buffer.alloc(0)
    let clientReceived = Buffer.alloc(0)

    serverSide.onData((data) => {
      serverReceived = Buffer.concat([serverReceived, Buffer.from(data)])
      if (serverReceived.length === toServerBytes.length) {
        for (const chunk of toClient) {
          serverSide.write(chunk)
        }
      }
    })

    client.onData((data) => {
      clientReceived = Buffer.concat([clientReceived, Buffer.from(data)])
      if (clientReceived.length === toClientBytes.length) {
        clientReceivedAll.resolve()
      }
    })

    for (const chunk of toServer) {
      client.write(chunk)
    }

    await clientReceivedAll.promise

    expect(serverReceived.equals(toServerBytes)).toBe(true)
    expect(clientReceived.equals(toClientBytes)).toBe(true)
  })

  it('fires onEnd then onClose (hadError false) on the peer after end()', async () => {
    const { client, serverSide } = await openPair()

    const events: string[] = []
    const closed = deferred<SocketCloseEvent>()

    serverSide.onEnd(() => {
      events.push('end')
      serverSide.end()
    })
    serverSide.onClose((e) => {
      events.push('close')
      closed.resolve(e)
    })

    client.end()

    const closeEvent = await closed.promise
    expect(events).toEqual(['end', 'close'])
    expect(closeEvent.hadError).toBe(false)
    expect(closeEvent.error).toBeUndefined()
  })

  it('fires onClose on the peer after the local side is disposed', async () => {
    const { client, serverSide } = await openPair()

    const closed = deferred<SocketCloseEvent>()
    serverSide.onClose((e) => closed.resolve(e))

    client.dispose()

    await closed.promise
  })

  it('does not throw when writing after dispose', async () => {
    const { client } = await openPair()

    client.dispose()

    expect(() => client.write(Buffer.from('late'))).not.toThrow()
  })

  it('dispose fires onClose exactly once (hadError false) and double dispose is safe', async () => {
    const { client } = await openPair()

    const events: SocketCloseEvent[] = []
    client.onClose((e) => events.push(e))

    client.dispose()
    client.dispose()

    expect(events).toHaveLength(1)
    expect(events[0]!.hadError).toBe(false)
    expect(events[0]!.error).toBeUndefined()
  })

  it('does not fire onClose again when disposed after a real close', async () => {
    const { client, serverSide } = await openPair()

    const events: SocketCloseEvent[] = []
    const closed = deferred<void>()
    client.onClose((e) => {
      events.push(e)
      closed.resolve()
    })
    serverSide.onEnd(() => serverSide.end())

    client.end()
    await closed.promise

    expect(events).toHaveLength(1)

    client.dispose()
    expect(events).toHaveLength(1)
  })

  it('readFirstControlFrame rejects when the socket is disposed mid-handshake', async () => {
    const server = createServer(() => {
      // accept and hold: never answer the handshake
    })
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = (server.address() as AddressInfo).port

    const client = await connectNodeSocket(port)
    sockets.push(client)

    const promise = readFirstControlFrame(client, 10_000)
    client.dispose()

    await expect(promise).rejects.toThrow('socket closed before control frame')
  })

  it('rejects connectNodeSocket when the connection is refused', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    await new Promise<void>((resolve) => server.close(() => resolve()))

    await expect(connectNodeSocket(port)).rejects.toBeInstanceOf(Error)
  })
})
