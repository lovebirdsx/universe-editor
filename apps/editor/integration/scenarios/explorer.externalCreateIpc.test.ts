/*---------------------------------------------------------------------------------------------
 *  Repro: an external `echo hello > test.txt` in the workspace root must surface
 *  in the Explorer tree. Wires the REAL FileWatcherMainService + real
 *  FileSystemMainService to the real ExplorerTreeService THROUGH the real IPC
 *  channel stack (ChannelServer/Client over an in-memory protocol), exactly as
 *  production does. Then creates a file out-of-band and asserts the tree refreshes.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ChannelClient,
  ChannelServer,
  IFileWatcherService,
  InMemoryMessagePassingProtocol,
  ProxyChannel,
  URI,
} from '@universe-editor/platform'
import { ExplorerTreeService } from '../../src/renderer/services/explorer/ExplorerTreeService.js'
import { FileWatcherMainService } from '../../src/main/services/fileWatcher/fileWatcherMainService.js'
import { WatcherProcessClient } from '@universe-editor/node-services'
import {
  createInMemoryWatcherTransport,
  type InMemoryWatcherTransport,
} from '@universe-editor/node-services'
import { createExplorerTree, waitFor, type FakeWorkspaceService } from '../fixtures/explorerTree.js'

const WATCHER_CHANNEL = 'fileWatcher'

describe('Explorer external file creation through IPC (integration)', () => {
  let rootDir: string
  let watcherTransports: InMemoryWatcherTransport[]
  let watcherClient: WatcherProcessClient
  let watcher: FileWatcherMainService
  let server: ChannelServer
  let client: ChannelClient
  let tree: ExplorerTreeService
  let ws: FakeWorkspaceService

  beforeEach(async () => {
    rootDir = await fsp.mkdtemp(join(tmpdir(), 'universe-editor-explorer-ipc-'))
    watcherTransports = []
    watcherClient = new WatcherProcessClient(() => {
      const t = createInMemoryWatcherTransport()
      watcherTransports.push(t)
      return t
    })
    watcher = new FileWatcherMainService(watcherClient)

    // --- main side: register the watcher as an IPC channel ---
    const [mainProto, rendererProto] = InMemoryMessagePassingProtocol.createPair()
    server = new ChannelServer(mainProto)
    server.registerChannel(WATCHER_CHANNEL, ProxyChannel.fromService(watcher))

    // --- renderer side: bind a proxy to the channel, like production ---
    client = new ChannelClient(rendererProto)
    const watcherProxy = ProxyChannel.toService<IFileWatcherService>(
      client.getChannel(WATCHER_CHANNEL),
    )

    // Start with NO workspace, then hydrate the root via an event — exactly the
    // renderer's startup-restore timing (RendererWorkspaceService.current is null
    // when ExplorerTreeService is constructed; the folder arrives async).
    const root = URI.file(rootDir)
    const fixture = createExplorerTree({ watcher: watcherProxy, root: null, focusRoot: root })
    tree = fixture.tree
    ws = fixture.workspace

    ws.hydrate(root)

    await waitFor(() => tree.isExpanded(tree.root!) && tree.getChildren(tree.root!) !== null)
    // Cold start (even via the async hydrate above) defers the watch to
    // WorkspaceWatchContribution (Eventually phase); simulate it explicitly.
    tree.startWatching()
  })

  afterEach(async () => {
    tree.dispose()
    client.dispose()
    server.dispose()
    // Await the real parcel unsubscribe before removing the watched tree.
    await watcher.unwatch()
    watcher.dispose()
    watcherClient.dispose()
    await Promise.allSettled(watcherTransports.map((t) => t.host.dispose()))
    await fsp.rm(rootDir, { recursive: true, force: true })
  })

  it('shows a file created externally in the workspace root', async () => {
    const root = tree.root!
    expect(tree.getChildren(root)).toHaveLength(0)

    await fsp.writeFile(join(rootDir, 'test.txt'), 'hello')

    await waitFor(() => (tree.getChildren(root) ?? []).some((c) => c.name === 'test.txt'))
    expect(tree.getChildren(root)?.some((c) => c.name === 'test.txt')).toBe(true)
  })
})
