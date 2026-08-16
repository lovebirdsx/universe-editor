/*---------------------------------------------------------------------------------------------
 *  Tests for RevealActiveFileInExplorerAction (主题 11 WP6).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  Emitter,
  IEditorGroupsService,
  IHostService,
  ILayoutService,
  ILoggerService,
  INotificationService,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  Severity,
  URI,
  registerAction2,
  type EditorInput,
  type Event,
  type IEditorGroup,
  type IEditorGroupsService as IEditorGroupsServiceType,
  type IHostService as IHostServiceType,
  type ILoggerService as ILoggerServiceType,
  type ILayoutService as ILayoutServiceType,
  type INotificationService as INotificationServiceType,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import {
  RevealActiveFileInExplorerAction,
  RevealInExplorerAction,
  RevealInOSExplorerAction,
} from '../revealActions.js'
import {
  IExplorerTreeService,
  type ExplorerTreeService,
} from '../../services/explorer/ExplorerTreeService.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { UntitledEditorInput } from '../../services/editor/UntitledEditorInput.js'

function makeFileInput(uri: URI): FileEditorInput {
  const input = Object.create(FileEditorInput.prototype) as FileEditorInput
  Object.defineProperty(input, 'resource', { get: () => uri })
  Object.defineProperty(input, 'typeId', { get: () => 'file' })
  return input
}

function makeGroups(active?: EditorInput): IEditorGroupsServiceType {
  const group = { activeEditor: active } as unknown as IEditorGroup
  return { activeGroup: group } as unknown as IEditorGroupsServiceType
}

class FakeExplorerTree {
  declare readonly _serviceBrand: undefined
  selectedResource: URI | null = null
  readonly revealed: string[] = []
  readonly onDidChange = new Emitter<void>().event
  async reveal(target: URI): Promise<boolean> {
    this.revealed.push(target.toString())
    return true
  }
}

class FakeLayout {
  declare readonly _serviceBrand: undefined
  readonly focusView = vi.fn(async () => true)
}

class FakeHost {
  declare readonly _serviceBrand: undefined
  readonly onDidChangeMaximized: Event<boolean> = new Emitter<boolean>().event
  readonly shownItems: string[] = []
  constructor(readonly platform: IHostServiceType['platform'] = 'win32') {}
  async showItemInFolder(fsPath: string): Promise<void> {
    this.shownItems.push(fsPath)
  }
}

class FakeNotification {
  declare readonly _serviceBrand: undefined
  readonly notified: Array<{ severity: Severity; message: string }> = []
  notify(opts: { severity: Severity; message: string }): void {
    this.notified.push(opts)
  }
}

class FakeLogger {
  declare readonly _serviceBrand: undefined
  readonly debugMessages: string[] = []
  createLogger(): { debug(message: string): void } {
    return { debug: (message: string) => this.debugMessages.push(message) }
  }
  setLevel(): void {}
  getLevel(): number {
    return 0
  }
}

function makeWorkspaceService(folder?: URI): IWorkspaceServiceType {
  const current: IWorkspace | null = folder ? { folder, name: 'workspace' } : null
  const workspaceEmitter = new Emitter<IWorkspace | null>()
  const recentEmitter = new Emitter<readonly []>()
  return {
    _serviceBrand: undefined,
    current,
    recent: [],
    onDidChangeWorkspace: workspaceEmitter.event,
    onDidChangeRecent: recentEmitter.event,
    whenReady: Promise.resolve(),
    async openFolder() {},
    async closeFolder() {},
    async removeRecent() {},
    async clearRecent() {},
  } as IWorkspaceServiceType
}

function makeHarness(
  active?: EditorInput,
  selectedResource?: URI,
  workspaceFolder?: URI,
  platform: IHostServiceType['platform'] = 'win32',
) {
  const tree = new FakeExplorerTree()
  const layout = new FakeLayout()
  tree.selectedResource = selectedResource ?? null
  const host = new FakeHost(platform)
  const notification = new FakeNotification()
  const logger = new FakeLogger()
  const services = new ServiceCollection()
  services.set(IEditorGroupsService, makeGroups(active))
  services.set(ILayoutService, layout as unknown as ILayoutServiceType)
  services.set(IExplorerTreeService, tree as unknown as ExplorerTreeService)
  services.set(IHostService, host as unknown as IHostServiceType)
  services.set(IWorkspaceService, makeWorkspaceService(workspaceFolder))
  services.set(INotificationService, notification as unknown as INotificationServiceType)
  services.set(ILoggerService, logger as unknown as ILoggerServiceType)
  const inst = new InstantiationService(services)
  return { inst, layout, tree, host, notification, logger }
}

function run(inst: InstantiationService, id: string, args?: unknown): Promise<unknown> {
  const cmd = CommandsRegistry.getCommand(id)
  if (!cmd) throw new Error(`Command ${id} not registered`)
  return inst.invokeFunction((accessor) => cmd.handler(accessor, args)) as Promise<unknown>
}

const disposables: Array<{ dispose(): void }> = []
beforeEach(() => {
  disposables.push(registerAction2(RevealInExplorerAction))
  disposables.push(registerAction2(RevealActiveFileInExplorerAction))
  disposables.push(registerAction2(RevealInOSExplorerAction))
})
afterEach(() => {
  while (disposables.length > 0) disposables.pop()?.dispose()
})

describe('RevealInExplorerAction', () => {
  it('uses the VSCode-compatible command id', () => {
    expect(RevealInExplorerAction.ID).toBe('revealInExplorer')
  })

  it('reveals a direct URI argument', async () => {
    const target = URI.file('/ws/src/from-uri.ts')
    const h = makeHarness()

    await run(h.inst, RevealInExplorerAction.ID, target.toJSON())

    expect(h.layout.focusView).toHaveBeenCalledWith('workbench.view.explorer.tree', {
      source: 'command',
    })
    expect(h.tree.revealed).toEqual([target.toString()])
  })

  it('waits for the Explorer tree to be focused before revealing, so its scroll listener is mounted', async () => {
    const target = URI.file('/ws/src/deeply-nested.ts')
    const h = makeHarness()
    let completeFocus: (() => void) | undefined
    h.layout.focusView.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          completeFocus = () => resolve(true)
        }),
    )

    const reveal = run(h.inst, RevealInExplorerAction.ID, target.toJSON())

    expect(h.layout.focusView).toHaveBeenCalledWith('workbench.view.explorer.tree', {
      source: 'command',
    })
    expect(h.tree.revealed).toEqual([])

    completeFocus?.()
    await reveal

    expect(h.tree.revealed).toEqual([target.toString()])
  })

  it('reveals a context resource argument', async () => {
    const target = URI.file('/ws/src/from-menu.ts')
    const h = makeHarness()

    await run(h.inst, RevealInExplorerAction.ID, { resource: target.toJSON() })

    expect(h.layout.focusView).toHaveBeenCalledWith('workbench.view.explorer.tree', {
      source: 'command',
    })
    expect(h.tree.revealed).toEqual([target.toString()])
  })

  it('reveals a source-control resourceUri path', async () => {
    const target = URI.file('/ws/src/from-scm.ts')
    const h = makeHarness()

    await run(h.inst, RevealInExplorerAction.ID, { resourceUri: target.fsPath })

    expect(h.layout.focusView).toHaveBeenCalledWith('workbench.view.explorer.tree', {
      source: 'command',
    })
    expect(h.tree.revealed).toEqual([target.toString()])
  })

  it('falls back to the active file editor when invoked without an argument', async () => {
    const target = URI.file('/ws/src/active.ts')
    const h = makeHarness(makeFileInput(target))

    await run(h.inst, RevealInExplorerAction.ID)

    expect(h.layout.focusView).toHaveBeenCalledWith('workbench.view.explorer.tree', {
      source: 'command',
    })
    expect(h.tree.revealed).toEqual([target.toString()])
  })

  it('does nothing for non-file resources', async () => {
    const h = makeHarness()

    await run(h.inst, RevealInExplorerAction.ID, URI.parse('untitled:Untitled-1').toJSON())

    expect(h.layout.focusView).not.toHaveBeenCalled()
    expect(h.tree.revealed).toHaveLength(0)
  })
})

describe('RevealActiveFileInExplorerAction', () => {
  it('opens the explorer container and reveals the active FileEditorInput', async () => {
    const target = URI.file('/ws/src/main.ts')
    const input = makeFileInput(target)
    const h = makeHarness(input)
    await run(h.inst, RevealActiveFileInExplorerAction.ID)
    expect(h.layout.focusView).toHaveBeenCalledWith('workbench.view.explorer.tree', {
      source: 'command',
    })
    expect(h.tree.revealed).toEqual([target.toString()])
  })

  it('uses the resource argument when given (tab right-click)', async () => {
    const target = URI.file('/ws/lib/util.ts')
    const h = makeHarness()
    await run(h.inst, RevealActiveFileInExplorerAction.ID, { resource: target.toJSON() })
    expect(h.layout.focusView).toHaveBeenCalledWith('workbench.view.explorer.tree', {
      source: 'command',
    })
    expect(h.tree.revealed).toEqual([target.toString()])
  })

  it('does nothing when the active editor is untitled', async () => {
    const untitled = new UntitledEditorInput()
    const h = makeHarness(untitled)
    await run(h.inst, RevealActiveFileInExplorerAction.ID)
    expect(h.layout.focusView).not.toHaveBeenCalled()
    expect(h.tree.revealed).toHaveLength(0)
  })

  it('does nothing when there is no active editor and no argument', async () => {
    const h = makeHarness()
    await run(h.inst, RevealActiveFileInExplorerAction.ID)
    expect(h.layout.focusView).not.toHaveBeenCalled()
    expect(h.tree.revealed).toHaveLength(0)
  })
})

describe('RevealInOSExplorerAction', () => {
  it('uses the resource argument when given (tab or Explorer right-click)', async () => {
    const active = URI.file('/ws/src/active.ts')
    const target = URI.file('/external/from-menu.txt')
    const h = makeHarness(makeFileInput(active), URI.file('/ws/src/selected.ts'))

    await run(h.inst, RevealInOSExplorerAction.ID, { resource: target.toJSON() })

    expect(h.host.shownItems).toEqual([target.fsPath])
  })

  it('uses the active external file instead of a stale Explorer selection when invoked without args', async () => {
    const active = URI.file('/external/outside.txt')
    const selected = URI.file('/ws/src/main.ts')
    const h = makeHarness(makeFileInput(active), selected)

    await run(h.inst, RevealInOSExplorerAction.ID)

    expect(h.host.shownItems).toEqual([active.fsPath])
  })

  it('falls back to the Explorer selection when there is no active file editor', async () => {
    const selected = URI.file('/ws/src/main.ts')
    const h = makeHarness(new UntitledEditorInput(), selected)

    await run(h.inst, RevealInOSExplorerAction.ID)

    expect(h.host.shownItems).toEqual([selected.fsPath])
  })

  it('falls back to the workspace folder when no file is selected', async () => {
    const workspace = URI.file('/ws')
    const h = makeHarness(undefined, undefined, workspace)

    await run(h.inst, RevealInOSExplorerAction.ID)

    expect(h.host.shownItems).toEqual([workspace.fsPath])
  })

  it('reveals a WSL remote resource as a UNC path on a Windows client', async () => {
    const target = URI.parse('remote-ssh://wsl+ubuntu-24.04/home/u/proj/file.txt')
    const h = makeHarness(undefined, undefined, undefined, 'win32')

    await run(h.inst, RevealInOSExplorerAction.ID, { resource: target.toJSON() })

    expect(h.host.shownItems).toEqual(['\\\\wsl$\\ubuntu-24.04\\home\\u\\proj\\file.txt'])
  })

  it('notifies instead of revealing a non-WSL remote resource', async () => {
    const target = URI.parse('remote-ssh://alice@host/home/u/proj/file.txt')
    const h = makeHarness(undefined, undefined, undefined, 'win32')

    await run(h.inst, RevealInOSExplorerAction.ID, { resource: target.toJSON() })

    expect(h.host.shownItems).toHaveLength(0)
    expect(h.notification.notified).toHaveLength(1)
    expect(h.notification.notified[0]?.severity).toBe(Severity.Info)
  })

  it('notifies instead of revealing a WSL remote on a non-Windows client', async () => {
    const target = URI.parse('remote-ssh://wsl+ubuntu-24.04/home/u/proj/file.txt')
    const h = makeHarness(undefined, undefined, undefined, 'linux')

    await run(h.inst, RevealInOSExplorerAction.ID, { resource: target.toJSON() })

    expect(h.host.shownItems).toHaveLength(0)
    expect(h.notification.notified).toHaveLength(1)
    expect(h.notification.notified[0]?.severity).toBe(Severity.Info)
  })
})
