/*---------------------------------------------------------------------------------------------
 *  The single place integration scenarios construct an ExplorerTreeService — its DI
 *  graph grows, and a per-scenario ServiceCollection silently injects undefined.
 *--------------------------------------------------------------------------------------------*/

import {
  Emitter,
  IFileService,
  IFileWatcherService,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IWorkspace,
  type IFileWatcherService as IFileWatcherServiceType,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import { ExplorerTreeService } from '../../src/renderer/services/explorer/ExplorerTreeService.js'
import { IExcludeService } from '../../src/renderer/services/exclude/ExcludeService.js'
import { FakeExcludeService } from '../../src/renderer/services/exclude/testing/fakeExcludeService.js'
import { IFocusScopeService } from '../../src/renderer/services/focus/FocusScopeService.js'
import { FakeFocusScopeService } from '../../src/renderer/services/focus/testing/fakeFocusScopeService.js'
import { FileSystemMainService } from '../../src/main/services/files/fileSystemMainService.js'

export class FakeWorkspaceService implements IWorkspaceServiceType {
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

export function waitFor(fn: () => boolean, timeout = 5000, interval = 25): Promise<void> {
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

export interface ExplorerTreeFixtureOptions {
  /** Real FileWatcherMainService, or a ProxyChannel proxy to one. */
  readonly watcher: IFileWatcherServiceType
  /**
   * Workspace root. Pass null to start with no workspace and call
   * `workspace.hydrate(root)` afterwards, reproducing the renderer's async
   * startup restore.
   */
  readonly root: URI | null
  /**
   * Root the default focus fake resolves its scan roots against, so they stay
   * non-empty like production's. Only needed when `root` is null — the fake reads
   * a static root rather than following the hydrate event. Ignored if `focus` is
   * passed.
   */
  readonly focusRoot?: URI
  /** Defaults to focus mode off, i.e. the whole root is in scope. */
  readonly focus?: IFocusScopeService
}

export interface ExplorerTreeFixture {
  readonly tree: ExplorerTreeService
  readonly workspace: FakeWorkspaceService
}

export function createExplorerTree(options: ExplorerTreeFixtureOptions): ExplorerTreeFixture {
  const workspace = new FakeWorkspaceService(options.root)
  const services = new ServiceCollection()
  services.set(IFileService, new FileSystemMainService())
  services.set(IFileWatcherService, options.watcher)
  services.set(IWorkspaceService, workspace)
  services.set(IExcludeService, new FakeExcludeService())
  const focus = options.focus ?? new FakeFocusScopeService([], options.focusRoot ?? options.root)
  services.set(IFocusScopeService, focus)
  const tree = new InstantiationService(services).createInstance(ExplorerTreeService)
  return { tree, workspace }
}
