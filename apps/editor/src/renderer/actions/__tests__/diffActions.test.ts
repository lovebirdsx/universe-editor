import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CommandsRegistry,
  GroupDirection,
  IEditorGroupsService,
  InstantiationService,
  ServiceCollection,
  registerAction2,
} from '@universe-editor/platform'
import { OpenDiffAction, OpenWebviewDiffAction, type OpenDiffPayload } from '../diffActions.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'

function buildServices(groups: EditorGroupsService): InstantiationService {
  const services = new ServiceCollection()
  services.set(IEditorGroupsService, groups)
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
})
