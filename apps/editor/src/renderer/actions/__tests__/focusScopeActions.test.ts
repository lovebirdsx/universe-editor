/*---------------------------------------------------------------------------------------------
 *  Tests for the focus-folder Action2 commands. Drives the handlers directly
 *  through the CommandsRegistry with a real ExplorerTreeService (target
 *  resolution — multi-select, root filtering, isDirectory — lives in the shared
 *  resolveContextOperations helper) and an in-memory FakeFocusScopeService.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  Emitter,
  ICommandService,
  IContextKeyService,
  IFileDialogService,
  IFileService,
  IFileWatcherService,
  ILoggerService,
  INotificationService,
  IQuickInputService,
  IUriIdentityService,
  IWorkspaceService,
  InstantiationService,
  NullLogger,
  ServiceCollection,
  Severity,
  URI,
  UriIdentityService,
  registerAction2,
  type ICommandService as ICommandServiceType,
  type IDirectoryEntry,
  type IFileDialogOptions,
  type IFileDialogService as IFileDialogServiceType,
  type IFileService as IFileServiceType,
  type IFileWatcherService as IFileWatcherServiceType,
  type INotification,
  type INotificationService as INotificationServiceType,
  type IQuickInputService as IQuickInputServiceType,
  type IQuickPickItem,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
  type QuickPickInput,
} from '@universe-editor/platform'
import {
  AddFolderToFocusAction,
  AddFoldersToFocusAction,
  ClearFocusScopeAction,
  FocusOnFolderAction,
  ManageFocusScopeAction,
  RemoveFolderFromFocusAction,
} from '../focusScopeActions.js'
import {
  ExplorerTreeService,
  IExplorerTreeService,
} from '../../services/explorer/ExplorerTreeService.js'
import { IExcludeService } from '../../services/exclude/ExcludeService.js'
import { FakeExcludeService } from '../../services/exclude/testing/fakeExcludeService.js'
import { IFocusScopeService } from '../../services/focus/FocusScopeService.js'
import { FakeFocusScopeService } from '../../services/focus/testing/fakeFocusScopeService.js'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeNoopWatcher(): IFileWatcherServiceType {
  return {
    _serviceBrand: undefined,
    onDidChangeFiles: new Emitter<readonly never[]>().event,
    onDidRestart: new Emitter<void>().event,
    async watch() {},
    async unwatch() {},
  } as unknown as IFileWatcherServiceType
}

/** In-memory directory listing the ExplorerTreeService lazy-loads from. */
function makeFs(dirs: Record<string, IDirectoryEntry[]>) {
  const map = new Map<string, IDirectoryEntry[]>(
    Object.entries(dirs).map(([k, v]) => [URI.file(k).toString(), v]),
  )
  return {
    _serviceBrand: undefined,
    async list(resource: URI): Promise<IDirectoryEntry[]> {
      return map.get(resource.toString()) ?? []
    },
  } as unknown as IFileServiceType
}

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

interface FileDialogStub extends IFileDialogServiceType {
  readonly openCalls: IFileDialogOptions[]
}

/** Answers `showOpenDialog` with `result` — `undefined` models a cancel. */
function makeFileDialogStub(result?: readonly URI[]): FileDialogStub {
  const openCalls: IFileDialogOptions[] = []
  return {
    _serviceBrand: undefined,
    openCalls,
    async showOpenDialog(opts: IFileDialogOptions) {
      openCalls.push(opts)
      return result ? [...result] : undefined
    },
    async showSaveDialog() {
      return undefined
    },
  }
}

interface QuickInputStub extends IQuickInputServiceType {
  readonly shownItems: QuickPickInput<IQuickPickItem>[][]
}

/**
 * Resolves `pick` with the item at `pickIndex` among the non-separator entries,
 * so a test names the row it wants without hard-coding separator positions.
 */
function makeQuickInputStub(pickIndex?: number): QuickInputStub {
  const shownItems: QuickPickInput<IQuickPickItem>[][] = []
  return {
    _serviceBrand: undefined,
    shownItems,
    async pick<T extends IQuickPickItem>(items: readonly QuickPickInput<T>[]) {
      shownItems.push([...items] as QuickPickInput<IQuickPickItem>[])
      if (pickIndex === undefined) return undefined
      const selectable = items.filter((item): item is T => !('type' in item))
      return selectable[pickIndex]
    },
  } as unknown as QuickInputStub
}

interface NotificationStub extends INotificationServiceType {
  readonly notified: Array<{ severity: Severity; message: string }>
}

function makeNotificationStub(): NotificationStub {
  const notified: Array<{ severity: Severity; message: string }> = []
  return {
    notified,
    notify: (n: Pick<INotification, 'severity' | 'message'>) => {
      notified.push({ severity: n.severity, message: n.message })
    },
  } as unknown as NotificationStub
}

/** Routes executeCommand back through the registry so manage → add really runs. */
function makeCommandService(inst: () => InstantiationService): ICommandServiceType {
  return {
    _serviceBrand: undefined,
    async executeCommand(id: string, ...args: unknown[]) {
      const cmd = CommandsRegistry.getCommand(id)
      if (!cmd) throw new Error(`Command ${id} not registered`)
      return inst().invokeFunction((accessor) => cmd.handler(accessor, ...args)) as never
    },
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  inst: InstantiationService
  root: URI
  src: URI
  lib: URI
  mainTs: URI
  tree: ExplorerTreeService
  focusScope: FakeFocusScopeService
  contextKeys: ContextKeyService
  fileDialog: FileDialogStub
  quickInput: QuickInputStub
  notifications: NotificationStub
}

function makeHarness(
  opts: {
    focusFolders?: readonly string[]
    /** URIs the folder dialog answers with; omitted means the user cancelled. */
    dialogResult?: readonly URI[]
    /** Index among the manage picker's non-separator rows to accept. */
    pickIndex?: number
    /** Pass null to model "no folder open". */
    workspaceRoot?: URI | null
  } = {},
): Harness {
  const root = URI.file('/ws')
  const src = URI.joinPath(root, 'src')
  const lib = URI.joinPath(root, 'lib')
  const mainTs = URI.joinPath(root, 'main.ts')
  const fs = makeFs({
    '/ws': [
      { name: 'src', isDirectory: true, isFile: false },
      { name: 'lib', isDirectory: true, isFile: false },
      { name: 'main.ts', isDirectory: false, isFile: true },
    ],
  })
  const ws = new FakeWorkspaceService(opts.workspaceRoot === undefined ? root : opts.workspaceRoot)
  const focusScope = new FakeFocusScopeService(opts.focusFolders ?? [], root)
  const contextKeys = new ContextKeyService()
  const fileDialog = makeFileDialogStub(opts.dialogResult)
  const quickInput = makeQuickInputStub(opts.pickIndex)
  const notifications = makeNotificationStub()

  const services = new ServiceCollection()
  services.set(IWorkspaceService, ws)
  services.set(IFileService, fs)
  services.set(IFileWatcherService, makeNoopWatcher())
  services.set(IExcludeService, new FakeExcludeService())
  services.set(IFocusScopeService, focusScope)
  services.set(IFileDialogService, fileDialog)
  services.set(IQuickInputService, quickInput)
  services.set(INotificationService, notifications)
  services.set(IUriIdentityService, new UriIdentityService('linux'))
  services.set(ILoggerService, {
    _serviceBrand: undefined,
    createLogger: () => new NullLogger(),
    setLevel: () => {},
    getLevel: () => 0,
  } as unknown as ILoggerService)
  services.set(IContextKeyService, contextKeys)
  const inst = new InstantiationService(services)
  services.set(
    ICommandService,
    makeCommandService(() => inst),
  )
  const tree = inst.createInstance(ExplorerTreeService)
  services.set(IExplorerTreeService, tree)

  return {
    inst,
    root,
    src,
    lib,
    mainTs,
    tree,
    focusScope,
    contextKeys,
    fileDialog,
    quickInput,
    notifications,
  }
}

/** Wait for the tree's fire-and-forget root listing to land in its node cache. */
async function waitForRootChildren(h: Harness): Promise<void> {
  for (let i = 0; i < 20 && h.tree.getChildren(h.root) === null; i++) {
    await Promise.resolve()
  }
}

function run(h: Harness, id: string, args?: unknown): Promise<unknown> {
  const cmd = CommandsRegistry.getCommand(id)
  if (!cmd) throw new Error(`Command ${id} not registered`)
  return h.inst.invokeFunction((accessor) => cmd.handler(accessor, args)) as Promise<unknown>
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const disposables: Array<{ dispose(): void }> = []
beforeEach(() => {
  disposables.push(registerAction2(FocusOnFolderAction))
  disposables.push(registerAction2(AddFolderToFocusAction))
  disposables.push(registerAction2(RemoveFolderFromFocusAction))
  disposables.push(registerAction2(ClearFocusScopeAction))
  disposables.push(registerAction2(AddFoldersToFocusAction))
  disposables.push(registerAction2(ManageFocusScopeAction))
})
afterEach(() => {
  while (disposables.length > 0) disposables.pop()?.dispose()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('focusScopeActions', () => {
  describe('FocusOnFolderAction', () => {
    it('replaces the focus set with the clicked folder', async () => {
      const h = makeHarness()
      await waitForRootChildren(h)
      await run(h, FocusOnFolderAction.ID, { target: h.src, isDirectory: true })
      expect(h.focusScope.folders).toEqual(['src'])
      expect(h.focusScope.active).toBe(true)
    })

    it('focuses every selected directory when the clicked row is in the selection', async () => {
      const h = makeHarness()
      await waitForRootChildren(h)
      h.tree.setSelection([h.src, h.lib], h.src)
      await run(h, FocusOnFolderAction.ID, { target: h.src, isDirectory: true })
      expect(h.focusScope.folders).toEqual(['src', 'lib'])
    })

    it('acts on the clicked row only when it is outside the selection', async () => {
      const h = makeHarness()
      await waitForRootChildren(h)
      h.tree.setSelection([h.src], h.src)
      await run(h, FocusOnFolderAction.ID, { target: h.lib, isDirectory: true })
      expect(h.focusScope.folders).toEqual(['lib'])
    })

    it('skips files in a mixed selection', async () => {
      const h = makeHarness()
      await waitForRootChildren(h)
      h.tree.setSelection([h.src, h.mainTs], h.src)
      await run(h, FocusOnFolderAction.ID, { target: h.src, isDirectory: true })
      expect(h.focusScope.folders).toEqual(['src'])
    })

    it('no-ops when the target is the workspace root', async () => {
      const h = makeHarness()
      await waitForRootChildren(h)
      await run(h, FocusOnFolderAction.ID, { target: h.root, isDirectory: true })
      expect(h.focusScope.folders).toEqual([])
      expect(h.focusScope.enabled).toBe(false)
    })

    it('acts on the Explorer selection when invoked without a target', async () => {
      const h = makeHarness()
      await waitForRootChildren(h)
      h.tree.setSelection([h.src], h.src)
      h.contextKeys.set('focusedView', 'workbench.view.explorer.tree')
      await run(h, FocusOnFolderAction.ID)
      expect(h.focusScope.folders).toEqual(['src'])
    })
  })

  describe('AddFolderToFocusAction', () => {
    it('adds the clicked folder to the existing set', async () => {
      const h = makeHarness({ focusFolders: ['src'] })
      await waitForRootChildren(h)
      await run(h, AddFolderToFocusAction.ID, { target: h.lib, isDirectory: true })
      expect(h.focusScope.folders).toEqual(['src', 'lib'])
    })
  })

  describe('RemoveFolderFromFocusAction', () => {
    it('removes the clicked folder from the set', async () => {
      const h = makeHarness({ focusFolders: ['src', 'lib'] })
      await waitForRootChildren(h)
      await run(h, RemoveFolderFromFocusAction.ID, { target: h.src, isDirectory: true })
      expect(h.focusScope.folders).toEqual(['lib'])
    })

    it('removes every selected focus folder', async () => {
      const h = makeHarness({ focusFolders: ['src', 'lib'] })
      await waitForRootChildren(h)
      h.tree.setSelection([h.src, h.lib], h.src)
      await run(h, RemoveFolderFromFocusAction.ID, { target: h.src, isDirectory: true })
      expect(h.focusScope.folders).toEqual([])
      expect(h.focusScope.active).toBe(false)
    })
  })

  describe('ClearFocusScopeAction', () => {
    it('turns focus mode off', async () => {
      const h = makeHarness({ focusFolders: ['src'] })
      await run(h, ClearFocusScopeAction.ID)
      expect(h.focusScope.enabled).toBe(false)
      expect(h.focusScope.active).toBe(false)
    })
  })

  // The whole reason this command exists: once focus is narrow the Explorer
  // hides exactly the folders the user wants to add next, so the append entry
  // point has to read the filesystem instead of the filtered tree.
  describe('AddFoldersToFocusAction', () => {
    it('adds every folder chosen in the dialog, relative to the workspace', async () => {
      const root = URI.file('/ws')
      const h = makeHarness({
        focusFolders: ['src'],
        dialogResult: [URI.joinPath(root, 'lib'), URI.joinPath(root, 'Tools/Editor')],
      })
      await run(h, AddFoldersToFocusAction.ID)
      expect(h.focusScope.folders).toEqual(['src', 'lib', 'Tools/Editor'])
    })

    it('browses folders only, starting at the workspace root', async () => {
      const h = makeHarness({ dialogResult: [URI.file('/ws/lib')] })
      await run(h, AddFoldersToFocusAction.ID)
      const opts = h.fileDialog.openCalls[0]
      expect(opts?.canSelectFiles).toBe(false)
      expect(opts?.canSelectFolders).toBe(true)
      expect(opts?.canSelectMany).toBe(true)
      expect(opts?.defaultUri?.toString()).toBe(URI.file('/ws').toString())
    })

    it('leaves the focus set untouched when the dialog is cancelled', async () => {
      const h = makeHarness({ focusFolders: ['src'] })
      await run(h, AddFoldersToFocusAction.ID)
      expect(h.focusScope.folders).toEqual(['src'])
      expect(h.notifications.notified).toEqual([])
    })

    it('skips selections outside the workspace and says so', async () => {
      // Silently dropping them would look like the command did nothing:
      // normalizeFocusFolders discards the `..` path the caller would produce.
      const h = makeHarness({
        focusFolders: ['src'],
        dialogResult: [URI.file('/elsewhere/Engine'), URI.file('/ws/lib')],
      })
      await run(h, AddFoldersToFocusAction.ID)
      expect(h.focusScope.folders).toEqual(['src', 'lib'])
      expect(h.notifications.notified).toHaveLength(1)
      expect(h.notifications.notified[0]?.severity).toBe(Severity.Warning)
    })

    it('skips the workspace root itself, which would mean "focus everything"', async () => {
      const h = makeHarness({ focusFolders: ['src'], dialogResult: [URI.file('/ws')] })
      await run(h, AddFoldersToFocusAction.ID)
      expect(h.focusScope.folders).toEqual(['src'])
      expect(h.notifications.notified).toHaveLength(1)
    })

    it('explains itself instead of opening a dialog with no folder open', async () => {
      const h = makeHarness({ workspaceRoot: null })
      await run(h, AddFoldersToFocusAction.ID)
      expect(h.fileDialog.openCalls).toEqual([])
      expect(h.notifications.notified).toHaveLength(1)
      expect(h.notifications.notified[0]?.severity).toBe(Severity.Info)
    })
  })

  describe('ManageFocusScopeAction', () => {
    it('offers each focused folder, then add and exit', async () => {
      const h = makeHarness({ focusFolders: ['src', 'lib'] })
      await run(h, ManageFocusScopeAction.ID)
      const shown = h.quickInput.shownItems[0] ?? []
      const labels = shown.map((item) => ('label' in item ? item.label : '<sep>'))
      expect(labels).toEqual(['src', 'lib', '<sep>', 'Add Folders...', 'Exit Focus Mode'])
    })

    it('removes the picked folder', async () => {
      const h = makeHarness({ focusFolders: ['src', 'lib'], pickIndex: 0 })
      await run(h, ManageFocusScopeAction.ID)
      expect(h.focusScope.folders).toEqual(['lib'])
      expect(h.focusScope.enabled).toBe(true)
    })

    it('delegates to the folder dialog when Add Folders is picked', async () => {
      const h = makeHarness({
        focusFolders: ['src'],
        pickIndex: 1,
        dialogResult: [URI.file('/ws/lib')],
      })
      await run(h, ManageFocusScopeAction.ID)
      expect(h.fileDialog.openCalls).toHaveLength(1)
      expect(h.focusScope.folders).toEqual(['src', 'lib'])
    })

    it('exits focus mode when Exit is picked', async () => {
      const h = makeHarness({ focusFolders: ['src'], pickIndex: 2 })
      await run(h, ManageFocusScopeAction.ID)
      expect(h.focusScope.enabled).toBe(false)
    })

    it('changes nothing when the picker is dismissed', async () => {
      const h = makeHarness({ focusFolders: ['src'] })
      await run(h, ManageFocusScopeAction.ID)
      expect(h.focusScope.folders).toEqual(['src'])
      expect(h.focusScope.enabled).toBe(true)
    })

    // The enabled-but-empty state is exactly the one a user needs a way out of,
    // so the menu must still offer add and exit with no folders to list.
    it('still offers add and exit in the enabled-but-empty state', async () => {
      const h = makeHarness()
      h.focusScope.setEnabledWithNoFolders()
      await run(h, ManageFocusScopeAction.ID)
      const shown = h.quickInput.shownItems[0] ?? []
      const labels = shown.map((item) => ('label' in item ? item.label : '<sep>'))
      expect(labels).toEqual(['Add Folders...', 'Exit Focus Mode'])
    })
  })
})
