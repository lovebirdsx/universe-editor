/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/contributions/WorkspaceRecentMenuContribution.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  CommandsRegistry,
  Emitter,
  IWindowsService,
  IWorkspaceService,
  InstantiationService,
  MenuId,
  MenuRegistry,
  ServiceCollection,
  URI,
  registerAction2,
  isSubmenuEntry,
  type IDisposable,
  type IOpenWindowInfo,
  type IRecentWorkspace,
  type IWindowsService as IWindowsServiceType,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import { ClearRecentWorkspacesAction } from '../../actions/workspaceActions.js'
import { WorkspaceRecentMenuContribution } from '../WorkspaceRecentMenuContribution.js'

interface WorkspaceStub extends IWorkspaceServiceType {
  setRecent(next: readonly IRecentWorkspace[]): void
  readonly openCalls: URI[]
}

function makeWorkspaceStub(initial: readonly IRecentWorkspace[] = []): WorkspaceStub {
  const wsEmitter = new Emitter<IWorkspace | null>()
  const recentEmitter = new Emitter<readonly IRecentWorkspace[]>()
  let currentRecent = initial
  const openCalls: URI[] = []
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
    whenReady: Promise.resolve(),
    setRecent(next) {
      currentRecent = next
      recentEmitter.fire(next)
    },
    async openFolder(folder?: URI) {
      if (folder) openCalls.push(folder)
    },
    async closeFolder() {
      // no-op
    },
    async clearRecent() {
      currentRecent = []
      recentEmitter.fire([])
    },
    async removeRecent() {
      // no-op
    },
  } as WorkspaceStub
}

interface WindowsStub {
  service: IWindowsServiceType
  setOpen(next: readonly IOpenWindowInfo[]): void
}

function makeWindowsStub(open: readonly IOpenWindowInfo[] = []): WindowsStub {
  const emitter = new Emitter<void>()
  let current = open
  return {
    service: {
      _serviceBrand: undefined,
      onDidChangeWindows: emitter.event,
      async getWindows() {
        return current
      },
      async isCurrentWindowFirst() {
        return true
      },
      async focusWindow() {},
      async openWindow() {},
      async quit() {},
    } as IWindowsServiceType,
    setOpen(next) {
      current = next
      emitter.fire()
    },
  }
}

function buildContribution(
  workspace: WorkspaceStub,
  windows: IWindowsServiceType = makeWindowsStub().service,
): {
  contribution: WorkspaceRecentMenuContribution
  dispose: () => void
} {
  const services = new ServiceCollection()
  services.set(IWorkspaceService, workspace)
  services.set(IWindowsService, windows)
  const inst = new InstantiationService(services)
  const contribution = inst.createInstance(WorkspaceRecentMenuContribution)
  return { contribution, dispose: () => contribution.dispose() }
}

describe('WorkspaceRecentMenuContribution', () => {
  const disposables: IDisposable[] = []
  // ClearRecentWorkspacesAction must be registered for its command ID to be valid.
  disposables.push(registerAction2(ClearRecentWorkspacesAction))

  afterEach(() => {
    while (disposables.length > 1) disposables.pop()?.dispose()
  })

  it('attaches the Open Recent submenu under the File menu', () => {
    const ws = makeWorkspaceStub()
    const { dispose } = buildContribution(ws)
    disposables.push({ dispose })
    const fileEntries = MenuRegistry.getMenuItems(MenuId.MenubarFileMenu)
    expect(
      fileEntries.some((i) => isSubmenuEntry(i) && i.submenu === MenuId.MenubarFileOpenRecentMenu),
    ).toBe(true)
  })

  it('with empty recent list only shows Clear Recently Opened', () => {
    const ws = makeWorkspaceStub()
    const { dispose } = buildContribution(ws)
    disposables.push({ dispose })
    const items = MenuRegistry.getMenuItems(MenuId.MenubarFileOpenRecentMenu)
    expect(items).toHaveLength(1)
    expect('command' in items[0]! ? items[0]!.command : '').toBe(ClearRecentWorkspacesAction.ID)
  })

  it('rebuilds entries when recent list changes', () => {
    const ws = makeWorkspaceStub()
    const { dispose } = buildContribution(ws)
    disposables.push({ dispose })
    ws.setRecent([
      { folder: URI.file('/tmp/a'), name: 'a', lastOpened: 2 },
      { folder: URI.file('/tmp/b'), name: 'b', lastOpened: 1 },
    ])
    const items = MenuRegistry.getMenuItems(MenuId.MenubarFileOpenRecentMenu)
    // 2 recent + 1 Clear
    expect(items).toHaveLength(3)
    const titles = items
      .filter((i): i is { command: string; title?: string } => 'command' in i)
      .map((i) => i.title)
    expect(titles).toContain('a')
    expect(titles).toContain('b')
    expect(titles).toContain('Clear Recently Opened')
  })

  it('clicking a dynamic recent entry calls workspaceService.openFolder', async () => {
    const ws = makeWorkspaceStub()
    const { dispose } = buildContribution(ws)
    disposables.push({ dispose })
    const folder = URI.file('/tmp/x')
    ws.setRecent([{ folder, name: 'x', lastOpened: 1 }])
    const cmd = CommandsRegistry.getCommand('workbench.action.openRecent.0')
    expect(cmd).toBeDefined()
    await cmd?.handler({ get: () => undefined as unknown } as never)
    expect(ws.openCalls).toHaveLength(1)
    expect(ws.openCalls[0]?.toString()).toBe(folder.toString())
  })

  it('clearing recent list removes dynamic entries', () => {
    const ws = makeWorkspaceStub()
    const { dispose } = buildContribution(ws)
    disposables.push({ dispose })
    ws.setRecent([{ folder: URI.file('/tmp/a'), name: 'a', lastOpened: 1 }])
    expect(MenuRegistry.getMenuItems(MenuId.MenubarFileOpenRecentMenu)).toHaveLength(2)
    ws.setRecent([])
    expect(MenuRegistry.getMenuItems(MenuId.MenubarFileOpenRecentMenu)).toHaveLength(1)
  })

  it('marks recent entries currently open in a window, refreshing on window change', async () => {
    const ws = makeWorkspaceStub([
      { folder: URI.file('/tmp/a'), name: 'a', lastOpened: 2 },
      { folder: URI.file('/tmp/b'), name: 'b', lastOpened: 1 },
    ])
    const windows = makeWindowsStub([{ id: 1, folder: URI.file('/tmp/a').toJSON(), name: 'a' }])
    const { dispose } = buildContribution(ws, windows.service)
    disposables.push({ dispose })
    // Let the initial async _refreshOpenFolders() settle.
    await Promise.resolve()
    await Promise.resolve()

    const titlesOf = (): (string | undefined)[] =>
      MenuRegistry.getMenuItems(MenuId.MenubarFileOpenRecentMenu)
        .filter((i): i is { command: string; title?: string } => 'command' in i)
        .map((i) => i.title)

    let titles = titlesOf()
    expect(titles).toContain('a (Opened)')
    expect(titles).toContain('b')

    // When /tmp/b also opens, its marker appears too.
    windows.setOpen([
      { id: 1, folder: URI.file('/tmp/a').toJSON(), name: 'a' },
      { id: 2, folder: URI.file('/tmp/b').toJSON(), name: 'b' },
    ])
    await Promise.resolve()
    await Promise.resolve()
    titles = titlesOf()
    expect(titles).toContain('a (Opened)')
    expect(titles).toContain('b (Opened)')
  })
})
