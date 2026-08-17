import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CommandsRegistry,
  Emitter,
  GroupDirection,
  IEditorGroupsService,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  URI,
  registerAction2,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import { OpenDiffAction, OpenWebviewDiffAction, type OpenDiffPayload } from '../diffActions.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import { DiffEditorInput } from '../../services/editor/DiffEditorInput.js'
import { WebviewDiffInput } from '../../services/editor/WebviewDiffInput.js'

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

function buildServices(groups: EditorGroupsService, folder?: URI): InstantiationService {
  const services = new ServiceCollection()
  services.set(IEditorGroupsService, groups)
  services.set(IWorkspaceService, makeWorkspaceService(folder))
  return new InstantiationService(services)
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
