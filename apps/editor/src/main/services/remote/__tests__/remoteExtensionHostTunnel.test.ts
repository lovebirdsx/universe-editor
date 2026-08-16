/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/remote/remoteExtensionHostTunnel.ts.
 *  Drives the tunnel against a minimal in-process daemon (a raw net server that
 *  answers the client handshake) so open()/dispose() run end-to-end without ssh.
 *--------------------------------------------------------------------------------------------*/

import { createServer, type AddressInfo, type Server } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import {
  DisposableTracker,
  NullLogger,
  RemoteConnectionType,
  decodeControlJson,
  encodeControlJson,
  markAsSingleton,
  readFirstControlFrame,
  setDisposableTracker,
  writeControlFrame,
  type IRemoteConnectionRequest,
  type IRemoteConnectionResponse,
} from '@universe-editor/platform'
import { connectNodeSocket, NodeSocket } from '@universe-editor/node-services'
import { RemoteExtensionHostTunnel } from '../remoteExtensionHostTunnel.js'

describe('RemoteExtensionHostTunnel', () => {
  it('disposes its socket synchronously on dispose (no leak)', async () => {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)

    let server: Server | undefined
    const serverSockets: NodeSocket[] = []
    try {
      server = createServer((raw) => {
        const socket = new NodeSocket(raw)
        serverSockets.push(socket)
        void (async () => {
          try {
            await readFirstControlFrame(socket, 10_000)
            writeControlFrame(
              socket,
              encodeControlJson({ type: 'ok' } satisfies IRemoteConnectionResponse),
            )
          } catch {
            socket.dispose()
          }
        })()
      })
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as AddressInfo).port

      const tunnel = new RemoteExtensionHostTunnel({
        authority: 'host',
        connectSocket: () => connectNodeSocket(port, '127.0.0.1'),
        buildRequest: () => ({
          token: 'test-token',
          connectionType: RemoteConnectionType.ExtensionHost,
          authority: 'host',
          reconnectionToken: 'test-reconnection-token',
          isReconnection: false,
        }),
        logger: markAsSingleton(new NullLogger()),
        label: 'test tunnel',
      })

      await tunnel.open()
      tunnel.dispose()
    } finally {
      for (const s of serverSockets) s.dispose()
      server?.close()
      const report = tracker.computeLeakingDisposables()
      setDisposableTracker(null)
      expect(report).toBeUndefined()
    }
  })

  it('disposes the in-flight reconnect handshake socket without leaking', async () => {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)

    let server: Server | undefined
    const serverSockets: NodeSocket[] = []
    let reconnectionSeen = false
    try {
      server = createServer((raw) => {
        const socket = new NodeSocket(raw)
        serverSockets.push(socket)
        void (async () => {
          try {
            const { data } = await readFirstControlFrame(socket, 10_000)
            const req = decodeControlJson<IRemoteConnectionRequest>(data)
            if (req.isReconnection) {
              reconnectionSeen = true
              // Hang: never answer the reconnection handshake, so the client's
              // readFirstControlFrame stays in flight until the tunnel disposes it.
              return
            }
            writeControlFrame(
              socket,
              encodeControlJson({ type: 'ok' } satisfies IRemoteConnectionResponse),
            )
          } catch {
            socket.dispose()
          }
        })()
      })
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as AddressInfo).port

      const tunnel = new RemoteExtensionHostTunnel({
        authority: 'host',
        connectSocket: () => connectNodeSocket(port, '127.0.0.1'),
        buildRequest: (isReconnection) => ({
          token: 'test-token',
          connectionType: RemoteConnectionType.ExtensionHost,
          authority: 'host',
          reconnectionToken: 'test-reconnection-token',
          isReconnection,
        }),
        logger: markAsSingleton(new NullLogger()),
        label: 'test tunnel',
      })

      await tunnel.open()

      // Drop the server side to force a transparent reconnect.
      serverSockets[0]!.dispose()
      await vi.waitFor(() => expect(reconnectionSeen).toBe(true), { timeout: 5000 })

      tunnel.dispose()
    } finally {
      for (const s of serverSockets) s.dispose()
      server?.close()
      const report = tracker.computeLeakingDisposables()
      setDisposableTracker(null)
      expect(report).toBeUndefined()
    }
  })
})
