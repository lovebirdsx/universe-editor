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
  Emitter,
  IFileService,
  IFileWatcherService,
  IWorkspaceService,
  InMemoryMessagePassingProtocol,
  InstantiationService,
  ProxyChannel,
  ServiceCollection,
  URI,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import { ExplorerTreeService } from '../../src/renderer/services/explorer/ExplorerTreeService.js'
import { IExcludeService } from '../../src/renderer/services/exclude/ExcludeService.js'
import { FakeExcludeService } from '../../src/renderer/services/exclude/testing/fakeExcludeService.js'
import { FileSystemMainService } from '../../src/main/services/files/fileSystemMainService.js'
import { FileWatcherMainService } from '../../src/main/services/fileWatcher/fileWatcherMainService.js'

class FakeWorkspaceService implements IWorkspaceServiceType {
  declare readonly _serviceBrand: undefined
  private readonly _changed = new Emitter<IWorkspace | null>()
  readonly onDidChangeWorkspace = this._changed.event
  readonly onDidChangeRecent = new Emitter<readonly never[]>().event
  current: IWorkspace | null
  readonly recent = [] as never[]
  readonly whenReady: Promise<void> = Promise.resolve()
  constructor(initial: URI | null) {
    this.current = initial ? { folder: initial, name: 'ws' } : null
  }
  async openFolder() {}
  async closeFolder() {}
  async clearRecent() {}
  async removeRecent() {}
  // Mimic the renderer's async hydrate: root arrives via an event AFTER the
  // ExplorerTreeService has already been constructed against a null workspace.
  hydrate(folder: URI) {
    this.current = { folder, name: 'ws' }
    this._changed.fire(this.current)
  }
}

function waitFor(fn: () => boolean, timeout = 5000, interval = 25): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (fn()) return resolve()
      if (Date.now() - start > timeout) return reject(new Error('waitFor timed out'))
      setTimeout(tick, interval)
    }
    tick()
  })
}

const WATCHER_CHANNEL = 'fileWatcher'

describe('Explorer external file creation through IPC (integration)', () => {
  let rootDir: string
  let watcher: FileWatcherMainService
  let server: ChannelServer
  let client: ChannelClient
  let tree: ExplorerTreeService
  let ws: FakeWorkspaceService

  beforeEach(async () => {
    rootDir = await fsp.mkdtemp(join(tmpdir(), 'universe-editor-explorer-ipc-'))
    watcher = new FileWatcherMainService()

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
    ws = new FakeWorkspaceService(null)
    const services = new ServiceCollection()
    services.set(IFileService, new FileSystemMainService())
    services.set(IFileWatcherService, watcherProxy)
    services.set(IWorkspaceService, ws)
    services.set(IExcludeService, new FakeExcludeService())
    const inst = new InstantiationService(services)
    tree = inst.createInstance(ExplorerTreeService)

    ws.hydrate(URI.file(rootDir))

    await waitFor(() => tree.isExpanded(tree.root!) && tree.getChildren(tree.root!) !== null)
    // Cold start (even via the async hydrate above) defers the watch to
    // WorkspaceWatchContribution (Eventually phase); simulate it explicitly.
    tree.startWatching()
  })

  afterEach(async () => {
    tree.dispose()
    client.dispose()
    server.dispose()
    watcher.dispose()
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
