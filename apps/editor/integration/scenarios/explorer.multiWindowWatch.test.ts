/*---------------------------------------------------------------------------------------------
 *  Regression: the file watcher is per-window (one FileWatcherMainService instance per
 *  window), so two windows watching two different workspace roots no longer steal each
 *  other's parcel subscription. Both windows keep detecting their own externally-created
 *  files. Before the fix the watcher was an application singleton with a single
 *  subscription, and the second window's watch() tore down the first's.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Emitter,
  IFileService,
  IFileWatcherService,
  IWorkspaceService,
  InstantiationService,
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

function makeTree(watcher: IFileWatcherService, root: string): ExplorerTreeService {
  const services = new ServiceCollection()
  services.set(IFileService, new FileSystemMainService())
  services.set(IFileWatcherService, watcher)
  services.set(IWorkspaceService, new FakeWorkspaceService(URI.file(root)))
  services.set(IExcludeService, new FakeExcludeService())
  return new InstantiationService(services).createInstance(ExplorerTreeService)
}

describe('FileWatcher is per-window across two windows', () => {
  let dirA: string
  let dirB: string
  let watcherA: FileWatcherMainService
  let watcherB: FileWatcherMainService
  let treeA: ExplorerTreeService
  let treeB: ExplorerTreeService

  beforeEach(async () => {
    dirA = await fsp.mkdtemp(join(tmpdir(), 'ue-win-a-'))
    dirB = await fsp.mkdtemp(join(tmpdir(), 'ue-win-b-'))
    watcherA = new FileWatcherMainService()
    watcherB = new FileWatcherMainService()
  })

  afterEach(async () => {
    treeA?.dispose()
    treeB?.dispose()
    watcherA.dispose()
    watcherB.dispose()
    await fsp.rm(dirA, { recursive: true, force: true })
    await fsp.rm(dirB, { recursive: true, force: true })
  })

  it('both windows detect external file creation in their own folder', async () => {
    // Each window has its own watcher instance, mirroring the per-window scope in main.
    treeA = makeTree(watcherA, dirA)
    await waitFor(() => treeA.isExpanded(treeA.root!) && treeA.getChildren(treeA.root!) !== null)

    treeB = makeTree(watcherB, dirB)
    await waitFor(() => treeB.isExpanded(treeB.root!) && treeB.getChildren(treeB.root!) !== null)
    // Let both subscriptions settle.
    await new Promise((r) => setTimeout(r, 200))

    await fsp.writeFile(join(dirA, 'created-in-A.txt'), 'hello')
    await fsp.writeFile(join(dirB, 'created-in-B.txt'), 'hello')

    await waitFor(
      () => (treeA.getChildren(treeA.root!) ?? []).some((c) => c.name === 'created-in-A.txt'),
      4000,
    )
    await waitFor(
      () => (treeB.getChildren(treeB.root!) ?? []).some((c) => c.name === 'created-in-B.txt'),
      4000,
    )
    expect(treeA.getChildren(treeA.root!)?.some((c) => c.name === 'created-in-A.txt')).toBe(true)
    expect(treeB.getChildren(treeB.root!)?.some((c) => c.name === 'created-in-B.txt')).toBe(true)
  })
})
