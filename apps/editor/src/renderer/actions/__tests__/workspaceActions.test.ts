/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/actions/workspaceActions.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  Emitter,
  IQuickInputService,
  IWorkspaceService,
  InstantiationService,
  KeybindingsRegistry,
  MenuId,
  MenuRegistry,
  ServiceCollection,
  URI,
  registerAction2,
  type IDisposable,
  type IQuickInputService as IQuickInputServiceType,
  type IQuickPick,
  type IQuickPickItem,
  type IRecentWorkspace,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import {
  ClearRecentWorkspacesAction,
  CloseFolderAction,
  OpenFolderAction,
  OpenRecentAction,
} from '../workspaceActions.js'

interface WorkspaceStub extends IWorkspaceServiceType {
  readonly openCalls: URI[]
  readonly clearCalls: number
  readonly closeCalls: number
  setRecent(recent: readonly IRecentWorkspace[]): void
}

function makeWorkspaceStub(recent: readonly IRecentWorkspace[] = []): WorkspaceStub {
  const wsEmitter = new Emitter<IWorkspace | null>()
  const recentEmitter = new Emitter<readonly IRecentWorkspace[]>()
  let currentRecent = recent
  const openCalls: URI[] = []
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
  } as WorkspaceStub
}

function makeQuickInputStub(pickResult: IQuickPickItem | undefined): IQuickInputServiceType & {
  pickCalls: IQuickPickItem[][]
} {
  const pickCalls: IQuickPickItem[][] = []
  return {
    _serviceBrand: undefined,
    pickCalls,
    createQuickPick<T extends IQuickPickItem>(): IQuickPick<T> {
      throw new Error('not used in these tests')
    },
    async pick<T extends IQuickPickItem>(items: readonly T[]): Promise<T | undefined> {
      pickCalls.push([...items])
      return pickResult as T | undefined
    },
    async input() {
      return undefined
    },
  } as IQuickInputServiceType & { pickCalls: IQuickPickItem[][] }
}

function runCommand(
  id: string,
  workspace: IWorkspaceServiceType,
  quickInput?: IQuickInputServiceType,
): Promise<unknown> {
  const services = new ServiceCollection()
  services.set(IWorkspaceService, workspace)
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
    const qi = makeQuickInputStub({ id: 'recent.1', label: 'b', index: 1 } as IQuickPickItem)
    await runCommand(OpenRecentAction.ID, ws, qi)
    expect(qi.pickCalls).toHaveLength(1)
    expect(qi.pickCalls[0]).toHaveLength(2)
    expect(ws.openCalls).toHaveLength(1)
    expect(ws.openCalls[0]?.toString()).toBe(folderB.toString())
  })

  it('OpenRecent.run with empty recent list is a no-op', async () => {
    disposables.push(registerAction2(OpenRecentAction))
    const ws = makeWorkspaceStub([])
    const qi = makeQuickInputStub(undefined)
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
