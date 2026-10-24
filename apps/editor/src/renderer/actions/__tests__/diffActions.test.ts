import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  Emitter,
  GroupDirection,
  IEditorGroupsService,
  IFileService,
  IInstantiationService,
  IUriIdentityService,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  URI,
  registerAction2,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import { OpenDiffAction, OpenWebviewDiffAction, type OpenDiffPayload } from '../diffActions.js'
import { GoToNextDifferenceAction, OpenDiffSourceFileAction } from '../diffActions.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import { DiffEditorInput } from '../../services/editor/DiffEditorInput.js'
import { DiffEditorRegistry } from '../../services/editor/DiffEditorRegistry.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { WebviewDiffInput } from '../../services/editor/WebviewDiffInput.js'
import {
  IAuxiliaryEditorWindowService,
  type OpenEditorInNewWindowOptions,
  type OpenEditorInNewWindowResult,
} from '../../services/windows/auxiliaryEditorWindowService.js'

class FakeAuxiliaryEditorWindowService {
  declare readonly _serviceBrand: undefined
  readonly calls: Array<{
    editor: unknown
    options: OpenEditorInNewWindowOptions | undefined
  }> = []
  fail = false

  constructor(private readonly _groups: EditorGroupsService) {}

  async openEditorInNewWindow(
    editor: never,
    options?: OpenEditorInNewWindowOptions,
  ): Promise<OpenEditorInNewWindowResult> {
    this.calls.push({ editor, options })
    if (this.fail) return { ok: false, reason: 'error' }
    return {
      ok: true,
      window: { part: { activeGroup: this._groups.activeGroup } } as never,
      editor,
    }
  }
}

function makeWorkspaceService(folder?: URI): IWorkspaceServiceType {
  const current: IWorkspace | null = folder ? { folder, name: 'workspace' } : null
  return {
    _serviceBrand: undefined,
    current,
    recent: [],
    onDidChangeWorkspace: new Emitter<IWorkspace | null>().event,
    onDidChangeRecent: new Emitter<readonly []>().event,
    whenReady: Promise.resolve(),
    async openFolder() {},
    async closeFolder() {},
    async removeRecent() {},
    async clearRecent() {},
  } as IWorkspaceServiceType
}

function buildServices(
  groups: EditorGroupsService,
  folder?: URI,
): InstantiationService & { aux: FakeAuxiliaryEditorWindowService } {
  const services = new ServiceCollection()
  services.set(IEditorGroupsService, groups)
  services.set(IWorkspaceService, makeWorkspaceService(folder))
  services.set(IFileService, {} as never)
  services.set(IUriIdentityService, {
    isEqual: (a: URI, b: URI) => a.toString() === b.toString(),
  } as never)
  const aux = new FakeAuxiliaryEditorWindowService(groups)
  services.set(IAuxiliaryEditorWindowService, aux as never)
  const inst = new InstantiationService(services)
  services.set(IInstantiationService, inst)
  return Object.assign(inst, { aux })
}

function payload(overrides?: Partial<OpenDiffPayload>): OpenDiffPayload {
  return {
    title: 'a.txt',
    originalUri: 'file:///ws/a.txt',
    original: 'before',
    modified: 'after',
    ...overrides,
  }
}

function runOpenDiff(inst: InstantiationService, p: OpenDiffPayload): void {
  const cmd = CommandsRegistry.getCommand(OpenDiffAction.ID)!
  inst.invokeFunction((accessor) => cmd.handler(accessor, p))
}

describe('OpenDiffAction — lock-aware routing', () => {
  const disposables: Array<{ dispose(): void }> = []

  beforeEach(() => {
    disposables.push(registerAction2(OpenDiffAction))
    disposables.push(registerAction2(OpenWebviewDiffAction))
  })

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('opens into the active group when it is unlocked', () => {
    const groups = new EditorGroupsService()
    const inst = buildServices(groups)
    runOpenDiff(inst, payload())
    expect(groups.activeGroup.editors.map((e) => e.id)).toContain('diff:file:///ws/a.txt')
  })

  it('routes a new diff to the unlocked group when the active group is locked', () => {
    const groups = new EditorGroupsService()
    const locked = groups.activeGroup
    const unlocked = groups.addGroup(locked, GroupDirection.Right)
    groups.activateGroup(locked)
    locked.lock(true)

    const inst = buildServices(groups)
    runOpenDiff(inst, payload())

    expect(locked.editors).toHaveLength(0)
    expect(unlocked.editors.map((e) => e.id)).toContain('diff:file:///ws/a.txt')
    expect(groups.activeGroup).toBe(unlocked)
  })

  it('creates a fresh group when every group is locked', () => {
    const groups = new EditorGroupsService()
    groups.activeGroup.lock(true)

    const inst = buildServices(groups)
    runOpenDiff(inst, payload())

    expect(groups.count).toBe(2)
    const target = groups.activeGroup
    expect(target.isLocked).toBe(false)
    expect(target.editors.map((e) => e.id)).toContain('diff:file:///ws/a.txt')
  })

  it('reuses an already-open diff in the active group even when it is locked', () => {
    const groups = new EditorGroupsService()
    const locked = groups.activeGroup
    const inst = buildServices(groups)
    runOpenDiff(inst, payload())
    expect(locked.editors).toHaveLength(1)

    locked.lock(true)
    runOpenDiff(inst, payload({ modified: 'after-2' }))

    expect(locked.editors).toHaveLength(1)
    expect(groups.count).toBe(1)
    expect(locked.activeEditor?.id).toBe('diff:file:///ws/a.txt')
  })

  it('does not activate the routed group when preserveFocus is set (SCM space-preview)', () => {
    const groups = new EditorGroupsService()
    const locked = groups.activeGroup
    const unlocked = groups.addGroup(locked, GroupDirection.Right)
    groups.activateGroup(locked)
    locked.lock(true)

    const inst = buildServices(groups)
    runOpenDiff(inst, payload({ preserveFocus: true }))

    expect(unlocked.editors.map((e) => e.id)).toContain('diff:file:///ws/a.txt')
    expect(groups.activeGroup).toBe(locked)
  })

  it('routes a new webview diff away from a locked active group', () => {
    const groups = new EditorGroupsService()
    const locked = groups.activeGroup
    const unlocked = groups.addGroup(locked, GroupDirection.Right)
    groups.activateGroup(locked)
    locked.lock(true)

    const inst = buildServices(groups)
    const cmd = CommandsRegistry.getCommand(OpenWebviewDiffAction.ID)!
    inst.invokeFunction((accessor) =>
      cmd.handler(accessor, {
        viewType: 'test.diff',
        title: 'a.xlsx',
        leftUri: 'file:///ws/a.xlsx',
        rightUri: 'file:///ws/a.xlsx',
        leftBase64: btoa('left'),
        rightBase64: btoa('right'),
      }),
    )

    expect(locked.editors).toHaveLength(0)
    expect(unlocked.editors).toHaveLength(1)
    expect(groups.activeGroup).toBe(unlocked)
  })

  const remoteFolder = () => URI.parse('remote-ssh://ws/home/dev')

  it('leaves a file:// URI unchanged in a local workspace', () => {
    const groups = new EditorGroupsService()
    const inst = buildServices(groups, URI.file('/ws'))
    runOpenDiff(inst, payload({ originalUri: 'file:///ws/a.txt', openableUri: 'file:///ws/a.txt' }))
    expect(groups.activeGroup.editors.map((e) => e.id)).toContain('diff:file:///ws/a.txt')
  })

  it('re-attaches the workspace authority to a file:// URI in a remote workspace', () => {
    const groups = new EditorGroupsService()
    const inst = buildServices(groups, remoteFolder())
    runOpenDiff(
      inst,
      payload({ originalUri: 'file:///home/x/a.txt', openableUri: 'file:///home/x/a.txt' }),
    )
    const input = groups.activeGroup.editors.find((e) => e instanceof DiffEditorInput)
    expect(input).toBeInstanceOf(DiffEditorInput)
    expect((input as DiffEditorInput).originalUri.toString()).toBe('remote-ssh://ws/home/x/a.txt')
    expect((input as DiffEditorInput).openableResource?.toString()).toBe(
      'remote-ssh://ws/home/x/a.txt',
    )
    expect(input?.id).toBe('diff:remote-ssh://ws/home/x/a.txt')
  })

  it('leaves an already-remote-ssh URI unchanged in a remote workspace', () => {
    const groups = new EditorGroupsService()
    const inst = buildServices(groups, remoteFolder())
    runOpenDiff(inst, payload({ originalUri: 'remote-ssh://ws/home/x/a.txt' }))
    expect(groups.activeGroup.editors.map((e) => e.id)).toContain(
      'diff:remote-ssh://ws/home/x/a.txt',
    )
  })

  it('re-attaches both webview diff sides to the remote workspace authority', () => {
    const groups = new EditorGroupsService()
    const inst = buildServices(groups, remoteFolder())
    const cmd = CommandsRegistry.getCommand(OpenWebviewDiffAction.ID)!
    inst.invokeFunction((accessor) =>
      cmd.handler(accessor, {
        viewType: 'test.diff',
        title: 'a.xlsx',
        leftUri: 'file:///home/x/a.xlsx',
        rightUri: 'file:///home/x/a.xlsx',
        leftBase64: btoa('left'),
        rightBase64: btoa('right'),
      }),
    )
    const input = groups.activeGroup.editors.find((e) => e instanceof WebviewDiffInput)
    expect(input).toBeInstanceOf(WebviewDiffInput)
    expect((input as WebviewDiffInput).leftUri.toString()).toBe('remote-ssh://ws/home/x/a.xlsx')
    expect((input as WebviewDiffInput).rightUri.toString()).toBe('remote-ssh://ws/home/x/a.xlsx')
  })
})

describe('OpenDiffAction — targeted opens', () => {
  const disposables: Array<{ dispose(): void }> = []

  beforeEach(() => {
    disposables.push(registerAction2(OpenDiffAction))
    disposables.push(registerAction2(OpenWebviewDiffAction))
  })

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
    DiffEditorRegistry._resetForTests()
  })

  it('opens a side diff in a new side group without touching the active group', () => {
    const groups = new EditorGroupsService()
    const inst = buildServices(groups)
    const active = groups.activeGroup

    runOpenDiff(inst, payload({ openTarget: 'side' }))

    expect(groups.count).toBe(2)
    const side = groups.groups.find((g) => g !== active)!
    expect(side.editors.map((e) => e.id)).toContain('diff:file:///ws/a.txt')
    expect(active.editors).toHaveLength(0)
    expect(groups.activeGroup).toBe(side)
  })

  it('reuses an existing diff already in the side group', () => {
    const groups = new EditorGroupsService()
    const inst = buildServices(groups)
    const active = groups.activeGroup

    runOpenDiff(inst, payload({ openTarget: 'side' }))
    const side = groups.activeGroup
    groups.activateGroup(active)
    runOpenDiff(inst, payload({ openTarget: 'side', modified: 'after-2' }))

    expect(groups.count).toBe(2)
    expect(side.editors).toHaveLength(1)
    expect(side.editors[0]?.id).toBe('diff:file:///ws/a.txt')
  })

  it('opens a fresh diff in an auxiliary window', () => {
    const groups = new EditorGroupsService()
    const inst = buildServices(groups)

    runOpenDiff(inst, payload({ openTarget: 'newWindow', pinned: true }))

    expect(inst.aux.calls).toHaveLength(1)
    expect(inst.aux.calls[0]!.options).toMatchObject({ mode: 'open', pinned: true })
    expect(groups.count).toBe(1)
  })

  it('falls back to the default path when the auxiliary window fails', async () => {
    const groups = new EditorGroupsService()
    const inst = buildServices(groups)
    inst.aux.fail = true

    runOpenDiff(inst, payload({ openTarget: 'newWindow' }))
    await vi.waitFor(() => {
      expect(groups.activeGroup.editors.map((e) => e.id)).toContain('diff:file:///ws/a.txt')
    })
  })

  it('opens a webview diff to the side with a fresh input', () => {
    const groups = new EditorGroupsService()
    const inst = buildServices(groups)
    const cmd = CommandsRegistry.getCommand(OpenWebviewDiffAction.ID)!

    inst.invokeFunction((accessor) =>
      cmd.handler(accessor, {
        viewType: 'test.diff',
        title: 'a.xlsx',
        leftUri: 'file:///ws/a.xlsx',
        rightUri: 'file:///ws/a.xlsx',
        leftBase64: btoa('left'),
        rightBase64: btoa('right'),
        openTarget: 'side',
      }),
    )

    expect(groups.count).toBe(2)
    const side = groups.groups[1]!
    expect(side.editors[0]).toBeInstanceOf(WebviewDiffInput)
  })
})

// A diff's title-bar buttons carry `{ groupId }`. They must act on the diff in
// that group even when another split is active.
describe('diff title actions follow the { groupId } of a non-active group', () => {
  const disposables: Array<{ dispose(): void }> = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
    DiffEditorRegistry._resetForTests()
  })

  function twoGroups() {
    const groups = new EditorGroupsService()
    const inst = buildServices(groups)
    const g1 = groups.activeGroup
    const resource = URI.file('/ws/a.txt')
    const diff = inst.createInstance(
      DiffEditorInput,
      resource,
      'before',
      'after',
      undefined,
      resource,
      false,
    )
    g1.openEditor(diff, { activate: true, pinned: true })
    const g2 = groups.addGroup(g1, GroupDirection.Right)
    const other = inst.createInstance(FileEditorInput, URI.file('/ws/b.txt'))
    g2.openEditor(other, { activate: true, pinned: true })
    groups.activateGroup(g2)
    return { groups, inst, g1, g2, diff, other, resource }
  }

  it('Open File opens the source in the named group', () => {
    const { inst, g1, g2, other, resource } = twoGroups()
    disposables.push(registerAction2(OpenDiffSourceFileAction))

    inst.invokeFunction((accessor) =>
      CommandsRegistry.getCommand(OpenDiffSourceFileAction.ID)!.handler(accessor, {
        groupId: g1.id,
      }),
    )

    const opened = g1.editors.find(
      (e) => e instanceof FileEditorInput && e.resource?.toString() === resource.toString(),
    )
    expect(opened).toBeDefined()
    expect(g2.editors).toEqual([other])
  })

  it('Go to Next Difference drives the named group diff editor', () => {
    const { inst, g1, g2, diff, other } = twoGroups()
    const calls: string[] = []
    DiffEditorRegistry.register(
      diff,
      { goToDiff: (target: string) => calls.push(target) } as never,
      g1.id,
    )
    disposables.push(registerAction2(GoToNextDifferenceAction))

    inst.invokeFunction((accessor) =>
      CommandsRegistry.getCommand(GoToNextDifferenceAction.ID)!.handler(accessor, {
        groupId: g1.id,
      }),
    )

    expect(calls).toEqual(['next'])
    expect(g2.editors).toEqual([other])
  })
})
