/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/workspace/workspaceRecentMenuContribution.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  CommandsRegistry,
  Emitter,
  IWorkspaceService,
  InstantiationService,
  MenuId,
  MenuRegistry,
  ServiceCollection,
  URI,
  registerAction2,
  isSubmenuEntry,
  type IDisposable,
  type IRecentWorkspace,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import { ClearRecentWorkspacesAction } from '../../../actions/workspaceActions.js'
import { WorkspaceRecentMenuContribution } from '../workspaceRecentMenuContribution.js'

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
  } as WorkspaceStub
}

function buildContribution(workspace: WorkspaceStub): {
  contribution: WorkspaceRecentMenuContribution
  dispose: () => void
} {
  const services = new ServiceCollection()
  services.set(IWorkspaceService, workspace)
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
})
