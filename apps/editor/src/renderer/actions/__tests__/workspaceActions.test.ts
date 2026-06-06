/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/actions/workspaceActions.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  Emitter,
  ILifecycleService,
  IProgressService,
  IQuickInputService,
  IWindowsService,
  IWorkspaceService,
  InstantiationService,
  KeybindingsRegistry,
  LifecycleService,
  MenuId,
  MenuRegistry,
  ServiceCollection,
  URI,
  registerAction2,
  type IDisposable,
  type IOpenWindowInfo,
  type IPickOptions,
  type IProgressOptions,
  type IProgressService as IProgressServiceType,
  type IProgressStep,
  type IQuickInputService as IQuickInputServiceType,
  type IQuickPick,
  type IQuickPickItem,
  type QuickPickInput,
  type IRecentWorkspace,
  type IWindowsService as IWindowsServiceType,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import { CancellationToken } from '@universe-editor/platform'
import {
  ClearRecentWorkspacesAction,
  CloseFolderAction,
  OpenFolderAction,
  OpenRecentAction,
} from '../workspaceActions.js'

interface WorkspaceStub extends IWorkspaceServiceType {
  readonly openCalls: URI[]
  readonly removeCalls: URI[]
  readonly clearCalls: number
  readonly closeCalls: number
  setRecent(recent: readonly IRecentWorkspace[]): void
}

function asQuickPickItem(
  item: QuickPickInput<IQuickPickItem> | undefined,
): IQuickPickItem | undefined {
  if (!item) return undefined
  if ('type' in item && item.type === 'separator') return undefined
  return item as IQuickPickItem
}

function makeWorkspaceStub(recent: readonly IRecentWorkspace[] = []): WorkspaceStub {
  const wsEmitter = new Emitter<IWorkspace | null>()
  const recentEmitter = new Emitter<readonly IRecentWorkspace[]>()
  let currentRecent = recent
  const openCalls: URI[] = []
  const removeCalls: URI[] = []
  let clearCalls = 0
  let closeCalls = 0
  return {
    _serviceBrand: undefined,
    get current() {
      return null
    },
    onDidChangeWorkspace: wsEmitter.event,
    get recent() {
      return currentRecent
    },
    onDidChangeRecent: recentEmitter.event,
    openCalls,
    removeCalls,
    get clearCalls() {
      return clearCalls
    },
    get closeCalls() {
      return closeCalls
    },
    setRecent(next) {
      currentRecent = next
      recentEmitter.fire(next)
    },
    async openFolder(folder?: URI) {
      if (folder) openCalls.push(folder)
      else openCalls.push(URI.parse('cmd:dialog'))
    },
    async closeFolder() {
      closeCalls++
    },
    async clearRecent() {
      clearCalls++
      currentRecent = []
      recentEmitter.fire([])
    },
    async removeRecent(folder: URI) {
      removeCalls.push(folder)
    },
  } as WorkspaceStub
}

interface QuickInputStubConfig {
  pickResult?: IQuickPickItem | undefined
  /** Simulate the user holding Ctrl when accepting. */
  ctrl?: boolean
  /** Simulate triggering remove on the item at this index before accepting. */
  removeIndex?: number
}

function makeQuickInputStub(cfg: QuickInputStubConfig = {}): IQuickInputServiceType & {
  pickCalls: QuickPickInput<IQuickPickItem>[][]
} {
  const pickCalls: QuickPickInput<IQuickPickItem>[][] = []
  return {
    _serviceBrand: undefined,
    pickCalls,
    createQuickPick<T extends IQuickPickItem>(): IQuickPick<T> {
      throw new Error('not used in these tests')
    },
    async pick<T extends IQuickPickItem>(
      items: readonly QuickPickInput<T>[],
      options?: IPickOptions,
    ): Promise<T | undefined> {
      pickCalls.push([...items])
      if (cfg.removeIndex !== undefined) {
        const target = asQuickPickItem(items[cfg.removeIndex])
        if (target) options?.onItemRemove?.(target)
      }
      if (cfg.ctrl && options?.keyMods) options.keyMods.ctrl = true
      return cfg.pickResult as T | undefined
    },
    async input() {
      return undefined
    },
  } as IQuickInputServiceType & { pickCalls: QuickPickInput<IQuickPickItem>[][] }
}

interface WindowsStub extends IWindowsServiceType {
  readonly openWindowCalls: (URI | undefined)[]
}

function makeWindowsStub(open: readonly IOpenWindowInfo[] = []): WindowsStub {
  const emitter = new Emitter<void>()
  const openWindowCalls: (URI | undefined)[] = []
  return {
    _serviceBrand: undefined,
    onDidChangeWindows: emitter.event,
    openWindowCalls,
    async getWindows() {
      return open
    },
    async isCurrentWindowFirst() {
      return true
    },
    async focusWindow() {},
    async openWindow(folder?: URI) {
      openWindowCalls.push(folder)
    },
    async quit() {},
  } as WindowsStub
}

function makeProgressStub(): IProgressServiceType {
  return {
    _serviceBrand: undefined,
    async withProgress<R>(
      _options: IProgressOptions,
      task: (
        progress: { report(value: IProgressStep): void },
        token: CancellationToken,
      ) => Promise<R>,
    ): Promise<R> {
      return task({ report() {} }, CancellationToken.None)
    },
  }
}

function runCommand(
  id: string,
  workspace: IWorkspaceServiceType,
  quickInput?: IQuickInputServiceType,
  windows: IWindowsServiceType = makeWindowsStub(),
): Promise<unknown> {
  const services = new ServiceCollection()
  services.set(IWorkspaceService, workspace)
  services.set(IProgressService, makeProgressStub())
  services.set(IWindowsService, windows)
  services.set(ILifecycleService, new LifecycleService())
  if (quickInput) services.set(IQuickInputService, quickInput)
  const inst = new InstantiationService(services)
  return new Promise((resolve) => {
    inst.invokeFunction(async (accessor) => {
      const cmd = CommandsRegistry.getCommand(id)!
      resolve(await cmd.handler(accessor))
    })
  })
}

describe('workspaceActions', () => {
  const disposables: IDisposable[] = []
  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('OpenFolder registers with chord, File menu, and command palette', () => {
    disposables.push(registerAction2(OpenFolderAction))
    expect(CommandsRegistry.getCommand(OpenFolderAction.ID)).toBeDefined()
    // chord resolves through the two-stroke path
    const first = KeybindingsRegistry.resolveKeystroke('ctrl+k')
    expect(first.kind).toBe('enter-chord')
    const second = KeybindingsRegistry.resolveKeystroke('ctrl+o', undefined, ['ctrl+k'])
    expect(second).toEqual({ kind: 'execute', command: OpenFolderAction.ID })
    expect(
      MenuRegistry.getMenuItems(MenuId.MenubarFileMenu).some(
        (i) => 'command' in i && i.command === OpenFolderAction.ID,
      ),
    ).toBe(true)
    expect(
      MenuRegistry.getMenuItems(MenuId.CommandPalette).some(
        (i) => 'command' in i && i.command === OpenFolderAction.ID,
      ),
    ).toBe(true)
  })

  it('OpenFolder.run delegates to IWorkspaceService.openFolder() without args', async () => {
    disposables.push(registerAction2(OpenFolderAction))
    const ws = makeWorkspaceStub()
    await runCommand(OpenFolderAction.ID, ws)
    expect(ws.openCalls).toHaveLength(1)
    expect(ws.openCalls[0]?.toString()).toBe('cmd:dialog')
  })

  it('CloseFolder.run delegates to IWorkspaceService.closeFolder()', async () => {
    disposables.push(registerAction2(CloseFolderAction))
    const ws = makeWorkspaceStub()
    await runCommand(CloseFolderAction.ID, ws)
    expect(ws.closeCalls).toBe(1)
  })

  it('OpenRecent.run shows a QuickPick from the recent list and opens the choice', async () => {
    disposables.push(registerAction2(OpenRecentAction))
    const folderA = URI.file('/tmp/a')
    const folderB = URI.file('/tmp/b')
    const ws = makeWorkspaceStub([
      { folder: folderA, name: 'a', lastOpened: 2 },
      { folder: folderB, name: 'b', lastOpened: 1 },
    ])
    const qi = makeQuickInputStub({
      pickResult: { id: 'recent.1', label: 'b', index: 1 } as IQuickPickItem,
    })
    await runCommand(OpenRecentAction.ID, ws, qi)
    expect(qi.pickCalls).toHaveLength(1)
    expect(qi.pickCalls[0]).toHaveLength(2)
    expect(ws.openCalls).toHaveLength(1)
    expect(ws.openCalls[0]?.toString()).toBe(folderB.toString())
  })

  it('OpenRecent.run marks entries already open in a window', async () => {
    disposables.push(registerAction2(OpenRecentAction))
    const folderA = URI.file('/tmp/a')
    const folderB = URI.file('/tmp/b')
    const ws = makeWorkspaceStub([
      { folder: folderA, name: 'a', lastOpened: 2 },
      { folder: folderB, name: 'b', lastOpened: 1 },
    ])
    const qi = makeQuickInputStub({})
    const windows = makeWindowsStub([{ id: 1, folder: folderA.toJSON(), name: 'a' }])
    await runCommand(OpenRecentAction.ID, ws, qi, windows)
    const items = qi.pickCalls[0]!
    expect(asQuickPickItem(items[0])?.iconId).toBe('check')
    expect(asQuickPickItem(items[1])?.iconId).toBeUndefined()
  })

  it('OpenRecent.run with Ctrl held opens the choice in a new window', async () => {
    disposables.push(registerAction2(OpenRecentAction))
    const folderA = URI.file('/tmp/a')
    const ws = makeWorkspaceStub([{ folder: folderA, name: 'a', lastOpened: 1 }])
    const qi = makeQuickInputStub({
      pickResult: { id: 'recent.0', label: 'a', index: 0 } as IQuickPickItem,
      ctrl: true,
    })
    const windows = makeWindowsStub()
    await runCommand(OpenRecentAction.ID, ws, qi, windows)
    expect(windows.openWindowCalls).toHaveLength(1)
    expect(windows.openWindowCalls[0]?.toString()).toBe(folderA.toString())
    // Same-window openFolder must NOT have been called.
    expect(ws.openCalls).toHaveLength(0)
  })

  it('OpenRecent.run remove affordance delegates to removeRecent', async () => {
    disposables.push(registerAction2(OpenRecentAction))
    const folderA = URI.file('/tmp/a')
    const folderB = URI.file('/tmp/b')
    const ws = makeWorkspaceStub([
      { folder: folderA, name: 'a', lastOpened: 2 },
      { folder: folderB, name: 'b', lastOpened: 1 },
    ])
    // Remove the second entry, then cancel (no pickResult).
    const qi = makeQuickInputStub({ removeIndex: 1 })
    await runCommand(OpenRecentAction.ID, ws, qi)
    expect(ws.removeCalls).toHaveLength(1)
    expect(ws.removeCalls[0]?.toString()).toBe(folderB.toString())
    expect(ws.openCalls).toHaveLength(0)
  })

  it('OpenRecent.run with empty recent list is a no-op', async () => {
    disposables.push(registerAction2(OpenRecentAction))
    const ws = makeWorkspaceStub([])
    const qi = makeQuickInputStub({})
    await runCommand(OpenRecentAction.ID, ws, qi)
    expect(qi.pickCalls).toHaveLength(0)
    expect(ws.openCalls).toHaveLength(0)
  })

  it('ClearRecent.run delegates to IWorkspaceService.clearRecent()', async () => {
    disposables.push(registerAction2(ClearRecentWorkspacesAction))
    const ws = makeWorkspaceStub([{ folder: URI.file('/tmp/x'), name: 'x', lastOpened: 1 }])
    await runCommand(ClearRecentWorkspacesAction.ID, ws)
    expect(ws.clearCalls).toBe(1)
  })

  it('OpenRecent registers Ctrl+R keybinding', () => {
    disposables.push(registerAction2(OpenRecentAction))
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+r')).toBe(OpenRecentAction.ID)
  })
})

// Spy on console to silence expected logs (none here, but defensive).
vi.spyOn(console, 'warn').mockImplementation(() => {})
