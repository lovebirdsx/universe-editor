import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  ILayoutService,
  IViewDescriptorService,
  IViewsService,
  InstantiationService,
  KeybindingsRegistry,
  PartId,
  ServiceCollection,
  ViewContainerLocation,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import { NextEditorAction, PreviousEditorAction } from '../editorActions.js'
import { NextViewContainerAction, PreviousViewContainerAction } from '../viewActions.js'

interface IMockState {
  focused: PartId | undefined
  containers: Partial<Record<ViewContainerLocation, string[]>>
  views: Record<string, string[]>
  active: Partial<Record<ViewContainerLocation, string>>
}

function makeServices(state: IMockState) {
  const focusView = vi.fn<(viewId: string) => Promise<boolean>>().mockResolvedValue(true)
  const openViewContainer = vi.fn<(id: string) => void>()

  const layout = {
    _serviceBrand: undefined,
    getPart: vi.fn((id: PartId) => ({ isFocused: () => id === state.focused })),
    focusView,
  } as never
  const views = {
    _serviceBrand: undefined,
    getActiveViewContainerId: (loc: ViewContainerLocation) => state.active[loc],
    openViewContainer,
  } as never
  const descriptors = {
    _serviceBrand: undefined,
    getViewContainersByLocation: (loc: ViewContainerLocation) =>
      (state.containers[loc] ?? []).map((id) => ({ id })),
    getViewsByContainer: (id: string) => (state.views[id] ?? []).map((vid) => ({ id: vid })),
  } as never

  const services = new ServiceCollection()
  services.set(ILayoutService, layout)
  services.set(IViewsService, views)
  services.set(IViewDescriptorService, descriptors)
  return { services, focusView, openViewContainer }
}

describe('View container cycling (ctrl+pageup/pagedown)', () => {
  const disposables: IDisposable[] = []
  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  async function exec(action: new () => never, state: IMockState) {
    const mocks = makeServices(state)
    const inst = new InstantiationService(mocks.services)
    disposables.push(registerAction2(action))
    const id = (action as unknown as { ID: string }).ID
    await inst.invokeFunction((accessor) => CommandsRegistry.getCommand(id)!.handler(accessor))
    return mocks
  }

  const THREE_CONTAINERS: IMockState = {
    focused: PartId.SideBar,
    containers: { [ViewContainerLocation.SideBar]: ['a', 'b', 'c'] },
    views: { a: ['a.1'], b: ['b.1'], c: ['c.1'] },
    active: { [ViewContainerLocation.SideBar]: 'a' },
  }

  it('next focuses the first view of the following container', async () => {
    const { focusView } = await exec(NextViewContainerAction as never, THREE_CONTAINERS)
    expect(focusView).toHaveBeenCalledTimes(1)
    expect(focusView.mock.calls[0]![0]).toBe('b.1')
  })

  it('previous wraps around to the last container', async () => {
    const { focusView } = await exec(PreviousViewContainerAction as never, THREE_CONTAINERS)
    expect(focusView).toHaveBeenCalledTimes(1)
    expect(focusView.mock.calls[0]![0]).toBe('c.1')
  })

  it('next wraps around from the last container to the first', async () => {
    const { focusView } = await exec(NextViewContainerAction as never, {
      ...THREE_CONTAINERS,
      active: { [ViewContainerLocation.SideBar]: 'c' },
    })
    expect(focusView.mock.calls[0]![0]).toBe('a.1')
  })

  it('cycles within the focused location only (Panel)', async () => {
    const { focusView } = await exec(NextViewContainerAction as never, {
      focused: PartId.Panel,
      containers: {
        [ViewContainerLocation.SideBar]: ['a', 'b'],
        [ViewContainerLocation.Panel]: ['out', 'term'],
      },
      views: { a: ['a.1'], b: ['b.1'], out: ['out.1'], term: ['term.1'] },
      active: { [ViewContainerLocation.Panel]: 'out' },
    })
    expect(focusView).toHaveBeenCalledTimes(1)
    expect(focusView.mock.calls[0]![0]).toBe('term.1')
  })

  it('cycles the SecondarySideBar location', async () => {
    const { focusView } = await exec(PreviousViewContainerAction as never, {
      focused: PartId.SecondarySideBar,
      containers: { [ViewContainerLocation.SecondarySideBar]: ['outline', 'aiDebug'] },
      views: { outline: ['outline.1'], aiDebug: ['aiDebug.1'] },
      active: { [ViewContainerLocation.SecondarySideBar]: 'aiDebug' },
    })
    expect(focusView.mock.calls[0]![0]).toBe('outline.1')
  })

  it('falls back to openViewContainer when the target has no views', async () => {
    const { focusView, openViewContainer } = await exec(NextViewContainerAction as never, {
      ...THREE_CONTAINERS,
      views: { a: ['a.1'], b: [], c: ['c.1'] },
    })
    expect(focusView).not.toHaveBeenCalled()
    expect(openViewContainer).toHaveBeenCalledWith('b')
  })

  it('no-ops with fewer than two containers', async () => {
    const { focusView, openViewContainer } = await exec(NextViewContainerAction as never, {
      ...THREE_CONTAINERS,
      containers: { [ViewContainerLocation.SideBar]: ['a'] },
    })
    expect(focusView).not.toHaveBeenCalled()
    expect(openViewContainer).not.toHaveBeenCalled()
  })

  it('no-ops when no view-container part is focused', async () => {
    const { focusView, openViewContainer } = await exec(NextViewContainerAction as never, {
      ...THREE_CONTAINERS,
      focused: PartId.EditorArea,
    })
    expect(focusView).not.toHaveBeenCalled()
    expect(openViewContainer).not.toHaveBeenCalled()
  })

  it('recovers from a stale active pointer (next → first, previous → last)', async () => {
    const stale = { ...THREE_CONTAINERS, active: { [ViewContainerLocation.SideBar]: 'gone' } }
    const next = await exec(NextViewContainerAction as never, stale)
    expect(next.focusView.mock.calls[0]![0]).toBe('a.1')
    const prev = await exec(PreviousViewContainerAction as never, stale)
    expect(prev.focusView.mock.calls[0]![0]).toBe('c.1')
  })

  describe('keybinding dispatch', () => {
    function ctxWith(entries: Record<string, boolean>): ContextKeyService {
      const ctx = new ContextKeyService()
      for (const [k, v] of Object.entries(entries)) ctx.createKey(k, v)
      return ctx
    }

    it('ctrl+pagedown resolves to the container cycle when a part is focused', () => {
      disposables.push(registerAction2(NextEditorAction))
      disposables.push(registerAction2(NextViewContainerAction))
      const ctx = ctxWith({ hasActiveEditor: true, panelFocus: true })
      try {
        expect(KeybindingsRegistry.resolveKeystroke('ctrl+pagedown', ctx)).toMatchObject({
          kind: 'execute',
          command: NextViewContainerAction.ID,
        })
      } finally {
        ctx.dispose()
      }
    })

    it('ctrl+pageup resolves to the container cycle when a sidebar is focused', () => {
      disposables.push(registerAction2(PreviousEditorAction))
      disposables.push(registerAction2(PreviousViewContainerAction))
      const ctx = ctxWith({ hasActiveEditor: true, sideBarFocus: true })
      try {
        expect(KeybindingsRegistry.resolveKeystroke('ctrl+pageup', ctx)).toMatchObject({
          kind: 'execute',
          command: PreviousViewContainerAction.ID,
        })
      } finally {
        ctx.dispose()
      }
    })

    it('editor cycling keeps the keys when no view-container part is focused', () => {
      disposables.push(registerAction2(NextEditorAction))
      disposables.push(registerAction2(PreviousEditorAction))
      disposables.push(registerAction2(NextViewContainerAction))
      disposables.push(registerAction2(PreviousViewContainerAction))
      const ctx = ctxWith({ hasActiveEditor: true })
      try {
        expect(KeybindingsRegistry.resolveKeystroke('ctrl+pagedown', ctx)).toMatchObject({
          kind: 'execute',
          command: NextEditorAction.ID,
        })
        expect(KeybindingsRegistry.resolveKeystroke('ctrl+pageup', ctx)).toMatchObject({
          kind: 'execute',
          command: PreviousEditorAction.ID,
        })
      } finally {
        ctx.dispose()
      }
    })
  })
})
