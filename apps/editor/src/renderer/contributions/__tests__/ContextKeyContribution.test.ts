import { afterEach, describe, expect, it } from 'vitest'
import {
  ContextKeyService,
  Emitter,
  LifecyclePhase,
  LifecycleService,
  observableValue,
  PartId,
  type HostPlatform,
} from '@universe-editor/platform'
import { ContextKeyContribution } from '../ContextKeyContribution.js'

function makeLayoutStub(initial?: Partial<Record<PartId, boolean>>) {
  const visible = observableValue<Readonly<Record<PartId, boolean>>>('layout', {
    [PartId.ActivityBar]: true,
    [PartId.SideBar]: true,
    [PartId.SecondarySideBar]: false,
    [PartId.EditorArea]: true,
    [PartId.Panel]: false,
    [PartId.StatusBar]: true,
    ...initial,
  })
  return { visible }
}

function makeEditorStub() {
  const activeEditor = observableValue<{ id: string } | undefined>('activeEditor', undefined)
  return { activeEditor }
}

function makeHostStub(platform: HostPlatform) {
  return { platform }
}

interface FakeEditor {
  id: string
  isDirty?: boolean
}

interface FakeGroup {
  index: number
  count: number
  activeEditor: FakeEditor | undefined
  editors: FakeEditor[]
  isFirst(e: FakeEditor): boolean
  isLast(e: FakeEditor): boolean
  onDidChangeModel: Emitter<void>['event']
  onDidActiveEditorChange: Emitter<void>['event']
  _modelEmitter: Emitter<void>
  _activeEmitter: Emitter<void>
}

function makeGroup(index: number, editors: FakeEditor[]): FakeGroup {
  const modelEmitter = new Emitter<void>()
  const activeEmitter = new Emitter<void>()
  const arr = [...editors]
  return {
    index,
    get count() {
      return arr.length
    },
    get editors() {
      return arr
    },
    get activeEditor() {
      return arr[0]
    },
    isFirst: (e: FakeEditor) => arr.indexOf(e) === 0,
    isLast: (e: FakeEditor) => arr.indexOf(e) === arr.length - 1,
    onDidChangeModel: modelEmitter.event,
    onDidActiveEditorChange: activeEmitter.event,
    _modelEmitter: modelEmitter,
    _activeEmitter: activeEmitter,
  }
}

function makeGroupsStub(groups: FakeGroup[] = [makeGroup(0, [])]) {
  const activeGroupChange = new Emitter<unknown>()
  const addGroup = new Emitter<unknown>()
  const removeGroup = new Emitter<unknown>()
  const moveGroup = new Emitter<unknown>()
  let active = groups[0]!
  return {
    get activeGroup() {
      return active
    },
    get groups() {
      return groups
    },
    setActive(g: FakeGroup) {
      active = g
      activeGroupChange.fire(g)
    },
    onDidActiveGroupChange: activeGroupChange.event,
    onDidAddGroup: addGroup.event,
    onDidRemoveGroup: removeGroup.event,
    onDidMoveGroup: moveGroup.event,
    _addGroup: addGroup,
    _removeGroup: removeGroup,
    _moveGroup: moveGroup,
  }
}

describe('ContextKeyContribution', () => {
  let contribution: ContextKeyContribution | undefined

  afterEach(() => {
    contribution?.dispose()
    contribution = undefined
  })

  it('seeds platform keys: exactly one of isWindows/isMac/isLinux is true', () => {
    const ctx = new ContextKeyService()
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('darwin') as never,
      makeLayoutStub() as never,
      makeEditorStub() as never,
      makeGroupsStub() as never,
      new LifecycleService(),
    )
    expect(ctx.get('isWindows')).toBe(false)
    expect(ctx.get('isMac')).toBe(true)
    expect(ctx.get('isLinux')).toBe(false)
    ctx.dispose()
  })

  it('reflects initial Part visibility', () => {
    const ctx = new ContextKeyService()
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub({ [PartId.SideBar]: true, [PartId.Panel]: false }) as never,
      makeEditorStub() as never,
      makeGroupsStub() as never,
      new LifecycleService(),
    )
    expect(ctx.get('sideBarVisible')).toBe(true)
    expect(ctx.get('panelVisible')).toBe(false)
    ctx.dispose()
  })

  it('synchronises sideBarVisible when LayoutService.visible changes', () => {
    const ctx = new ContextKeyService()
    const layout = makeLayoutStub({ [PartId.SideBar]: true })
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('linux') as never,
      layout as never,
      makeEditorStub() as never,
      makeGroupsStub() as never,
      new LifecycleService(),
    )
    expect(ctx.get('sideBarVisible')).toBe(true)
    layout.visible.set({ ...layout.visible.get(), [PartId.SideBar]: false }, undefined)
    expect(ctx.get('sideBarVisible')).toBe(false)
    ctx.dispose()
  })

  it('synchronises activeEditorId / hasActiveEditor on editor change', () => {
    const ctx = new ContextKeyService()
    const editor = makeEditorStub()
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      editor as never,
      makeGroupsStub() as never,
      new LifecycleService(),
    )
    expect(ctx.get('hasActiveEditor')).toBe(false)
    expect(ctx.get('activeEditorId')).toBeUndefined()
    editor.activeEditor.set({ id: 'file:///a.lua' }, undefined)
    expect(ctx.get('hasActiveEditor')).toBe(true)
    expect(ctx.get('activeEditorId')).toBe('file:///a.lua')
    ctx.dispose()
  })

  it('sets workbenchReady once the Ready phase is reached', async () => {
    const ctx = new ContextKeyService()
    const lifecycle = new LifecycleService()
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      makeEditorStub() as never,
      makeGroupsStub() as never,
      lifecycle,
    )
    expect(ctx.get('workbenchReady')).toBe(false)
    lifecycle.setPhase(LifecyclePhase.Ready)
    await lifecycle.when(LifecyclePhase.Ready)
    expect(ctx.get('workbenchReady')).toBe(true)
    ctx.dispose()
  })

  it('sets workbenchRestored once the Restored phase is reached', async () => {
    const ctx = new ContextKeyService()
    const lifecycle = new LifecycleService()
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      makeEditorStub() as never,
      makeGroupsStub() as never,
      lifecycle,
    )
    expect(ctx.get('workbenchRestored')).toBe(false)
    lifecycle.setPhase(LifecyclePhase.Restored)
    await lifecycle.when(LifecyclePhase.Restored)
    expect(ctx.get('workbenchRestored')).toBe(true)
    ctx.dispose()
  })

  // ---- group-level keys --------------------------------------------------

  it('editorPartMultipleEditorGroups reflects group count', () => {
    const ctx = new ContextKeyService()
    const g0 = makeGroup(0, [])
    const groups = makeGroupsStub([g0])
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      makeEditorStub() as never,
      groups as never,
      new LifecycleService(),
    )
    expect(ctx.get('editorPartMultipleEditorGroups')).toBe(false)
    groups.groups.push(makeGroup(1, []))
    groups._addGroup.fire({})
    expect(ctx.get('editorPartMultipleEditorGroups')).toBe(true)
    ctx.dispose()
  })

  it('editorIsOpen reflects any group having editors', () => {
    const ctx = new ContextKeyService()
    const g0 = makeGroup(0, [])
    const groups = makeGroupsStub([g0])
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      makeEditorStub() as never,
      groups as never,
      new LifecycleService(),
    )
    expect(ctx.get('editorIsOpen')).toBe(false)
    g0.editors.push({ id: 'a' })
    g0._modelEmitter.fire()
    expect(ctx.get('editorIsOpen')).toBe(true)
    ctx.dispose()
  })

  it('groupEditorsCount reflects active group count', () => {
    const ctx = new ContextKeyService()
    const g0 = makeGroup(0, [{ id: 'a' }, { id: 'b' }])
    const groups = makeGroupsStub([g0])
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      makeEditorStub() as never,
      groups as never,
      new LifecycleService(),
    )
    expect(ctx.get('groupEditorsCount')).toBe(2)
    ctx.dispose()
  })

  it('activeEditorGroupIndex reflects active group index', () => {
    const ctx = new ContextKeyService()
    const g0 = makeGroup(0, [])
    const g1 = makeGroup(1, [])
    const groups = makeGroupsStub([g0, g1])
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      makeEditorStub() as never,
      groups as never,
      new LifecycleService(),
    )
    expect(ctx.get('activeEditorGroupIndex')).toBe(0)
    groups.setActive(g1)
    expect(ctx.get('activeEditorGroupIndex')).toBe(1)
    ctx.dispose()
  })

  it('activeEditorIsFirstInGroup / activeEditorIsLastInGroup reflect position', () => {
    const ctx = new ContextKeyService()
    const a = { id: 'a' }
    const g0 = makeGroup(0, [a])
    const groups = makeGroupsStub([g0])
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      makeEditorStub() as never,
      groups as never,
      new LifecycleService(),
    )
    expect(ctx.get('activeEditorIsFirstInGroup')).toBe(true)
    expect(ctx.get('activeEditorIsLastInGroup')).toBe(true)
    ctx.dispose()
  })

  it('activeEditorIsDirty reflects dirty state', () => {
    const ctx = new ContextKeyService()
    const a = { id: 'a', isDirty: true }
    const g0 = makeGroup(0, [a])
    const groups = makeGroupsStub([g0])
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      makeEditorStub() as never,
      groups as never,
      new LifecycleService(),
    )
    expect(ctx.get('activeEditorIsDirty')).toBe(true)
    ctx.dispose()
  })
})
