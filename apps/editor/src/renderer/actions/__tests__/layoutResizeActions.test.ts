import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  IContextKeyService,
  IEditorGroupsService,
  ILayoutService,
  InstantiationService,
  KeybindingsRegistry,
  PartId,
  ServiceCollection,
  registerAction2,
  type IDisposable,
  type LayoutSizes,
} from '@universe-editor/platform'
import {
  IncreaseViewWidthAction,
  DecreaseViewWidthAction,
  IncreaseViewHeightAction,
  DecreaseViewHeightAction,
} from '../layoutActions.js'
import { MoveEditorToRightGroupAction } from '../editorActions.js'
import { SIDEBAR_MAX, PANEL_MIN, RESIZE_STEP } from '../../services/layout/layoutConstraints.js'
import { IViewPaneResizeRegistry } from '../../services/views/viewPaneResizeRegistry.js'

const DEFAULT_SIZES: LayoutSizes = { sidebar: 300, secondarySidebar: 300, panel: 300 }

const VIEW_ID = 'workbench.view.scm.commitChanges'

const disposables: IDisposable[] = []
afterEach(() => {
  while (disposables.length > 0) disposables.pop()?.dispose()
})

function makeLayout(
  focused: PartId | undefined,
  opts: { sizes?: Partial<LayoutSizes>; hidden?: PartId[] } = {},
) {
  const sizes: LayoutSizes = { ...DEFAULT_SIZES, ...opts.sizes }
  const hidden = new Set(opts.hidden ?? [])
  const setSize = vi.fn<(key: keyof LayoutSizes, value: number) => void>()
  const mock = {
    _serviceBrand: undefined,
    getPart: vi.fn((id: PartId) => ({ isFocused: () => id === focused })),
    getVisible: vi.fn((id: PartId) => !hidden.has(id)),
    sizes: { get: () => sizes },
    setSize,
  } as never
  return { mock, setSize }
}

/**
 * `handled` stands in for "the editor grid owns a split along that axis": false
 * (the default) is the single-group case, where the chrome resize still runs.
 */
function makeGroups(handled = false) {
  const activeGroup = { id: 7 }
  const resizeGroup = vi.fn(() => handled)
  const mock = { _serviceBrand: undefined, activeGroup, resizeGroup } as never
  return { mock, resizeGroup, activeGroup }
}

/**
 * `handled` stands in for "a stack container hosts the view and could move a
 * pixel": false is the unhandled case (lone view, tiled panel, no focused view),
 * where the caller must fall back to its part-level behaviour.
 */
function makeRegistry(handled = true) {
  const resize = vi.fn(() => handled)
  const mock = { _serviceBrand: undefined, register: vi.fn(), resize } as never
  return { mock, resize }
}

interface ExecOptions {
  /** Seeds the root `focusedViewPane` key; omit to leave the key unset. */
  focusedView?: string
  registry?: ReturnType<typeof makeRegistry>
}

function exec(
  action: new () => never,
  layoutMock: never,
  groupsMock?: never,
  opts: ExecOptions = {},
): ReturnType<typeof makeRegistry> {
  const registry = opts.registry ?? makeRegistry()
  const services = new ServiceCollection()
  services.set(ILayoutService, layoutMock)
  services.set(IEditorGroupsService, groupsMock ?? (makeGroups().mock as never))
  const ctx = new ContextKeyService()
  if (opts.focusedView !== undefined) ctx.createKey('focusedViewPane', opts.focusedView)
  services.set(IContextKeyService, ctx)
  services.set(IViewPaneResizeRegistry, registry.mock)
  const inst = new InstantiationService(services)
  disposables.push(registerAction2(action), ctx)
  inst.invokeFunction((accessor) => {
    const id = (action as unknown as { ID: string }).ID
    CommandsRegistry.getCommand(id)!.handler(accessor)
  })
  return registry
}

describe('Keyboard resize of the focused part', () => {
  it('SideBar focused: right grows sidebar, left shrinks it', () => {
    const a = makeLayout(PartId.SideBar)
    exec(IncreaseViewWidthAction as never, a.mock)
    expect(a.setSize).toHaveBeenCalledWith('sidebar', 300 + RESIZE_STEP)

    const b = makeLayout(PartId.SideBar)
    exec(DecreaseViewWidthAction as never, b.mock)
    expect(b.setSize).toHaveBeenCalledWith('sidebar', 300 - RESIZE_STEP)
  })

  it('SideBar focused: vertical resize is a no-op without a focused view pane', () => {
    const a = makeLayout(PartId.SideBar)
    exec(IncreaseViewHeightAction as never, a.mock)
    exec(DecreaseViewHeightAction as never, a.mock)
    expect(a.setSize).not.toHaveBeenCalled()
  })

  it('SecondarySideBar focused: width grows its own size', () => {
    const a = makeLayout(PartId.SecondarySideBar)
    exec(IncreaseViewWidthAction as never, a.mock)
    expect(a.setSize).toHaveBeenCalledWith('secondarySidebar', 300 + RESIZE_STEP)
  })

  it('Panel focused: down grows panel height, up shrinks it', () => {
    const a = makeLayout(PartId.Panel)
    exec(IncreaseViewHeightAction as never, a.mock)
    expect(a.setSize).toHaveBeenCalledWith('panel', 300 + RESIZE_STEP)

    const b = makeLayout(PartId.Panel)
    exec(DecreaseViewHeightAction as never, b.mock)
    expect(b.setSize).toHaveBeenCalledWith('panel', 300 - RESIZE_STEP)
  })

  it('Panel focused: right widens the center column by shrinking secondary', () => {
    const a = makeLayout(PartId.Panel)
    exec(IncreaseViewWidthAction as never, a.mock)
    expect(a.setSize).toHaveBeenCalledWith('secondarySidebar', 300 - RESIZE_STEP)
  })

  it('Editor focused: down grows editor by shrinking the panel', () => {
    const a = makeLayout(PartId.EditorArea)
    exec(IncreaseViewHeightAction as never, a.mock)
    expect(a.setSize).toHaveBeenCalledWith('panel', 300 - RESIZE_STEP)
  })

  it('Editor focused: up shrinks editor by growing the panel', () => {
    const a = makeLayout(PartId.EditorArea)
    exec(DecreaseViewHeightAction as never, a.mock)
    expect(a.setSize).toHaveBeenCalledWith('panel', 300 + RESIZE_STEP)
  })

  it('Editor focused: right shrinks secondary when visible', () => {
    const a = makeLayout(PartId.EditorArea)
    exec(IncreaseViewWidthAction as never, a.mock)
    expect(a.setSize).toHaveBeenCalledWith('secondarySidebar', 300 - RESIZE_STEP)
  })

  it('Editor focused: right falls back to sidebar when secondary is hidden', () => {
    const a = makeLayout(PartId.EditorArea, { hidden: [PartId.SecondarySideBar] })
    exec(IncreaseViewWidthAction as never, a.mock)
    expect(a.setSize).toHaveBeenCalledWith('sidebar', 300 - RESIZE_STEP)
  })

  it('Editor focused: single group + both sidebars hidden: width is a no-op', () => {
    const a = makeLayout(PartId.EditorArea, {
      hidden: [PartId.SecondarySideBar, PartId.SideBar],
    })
    exec(IncreaseViewWidthAction as never, a.mock)
    expect(a.setSize).not.toHaveBeenCalled()
  })

  it('clamps to max so a near-max sidebar does not overshoot', () => {
    const a = makeLayout(PartId.SideBar, { sizes: { sidebar: SIDEBAR_MAX - 10 } })
    exec(IncreaseViewWidthAction as never, a.mock)
    expect(a.setSize).toHaveBeenCalledWith('sidebar', SIDEBAR_MAX)
  })

  it('clamps to min so a near-min panel does not undershoot', () => {
    const a = makeLayout(PartId.Panel, { sizes: { panel: PANEL_MIN + 10 } })
    exec(DecreaseViewHeightAction as never, a.mock)
    expect(a.setSize).toHaveBeenCalledWith('panel', PANEL_MIN)
  })

  it('no focused resizable part: no-op', () => {
    const a = makeLayout(undefined)
    exec(IncreaseViewWidthAction as never, a.mock)
    exec(IncreaseViewHeightAction as never, a.mock)
    expect(a.setSize).not.toHaveBeenCalled()
  })

  // -- The editor area with a sibling group: the grid owns the split ----------

  it('Editor focused: a sibling group absorbs the width change instead of the sidebar', () => {
    const a = makeLayout(PartId.EditorArea)
    const groups = makeGroups(true)
    exec(IncreaseViewWidthAction as never, a.mock, groups.mock)
    expect(groups.resizeGroup).toHaveBeenCalledWith(groups.activeGroup, 'width', RESIZE_STEP)
    expect(a.setSize).not.toHaveBeenCalled()

    const b = makeLayout(PartId.EditorArea)
    const shrink = makeGroups(true)
    exec(DecreaseViewWidthAction as never, b.mock, shrink.mock)
    expect(shrink.resizeGroup).toHaveBeenCalledWith(shrink.activeGroup, 'width', -RESIZE_STEP)
    expect(b.setSize).not.toHaveBeenCalled()
  })

  it('Editor focused: a vertically split group absorbs the height change', () => {
    const a = makeLayout(PartId.EditorArea)
    const groups = makeGroups(true)
    exec(IncreaseViewHeightAction as never, a.mock, groups.mock)
    expect(groups.resizeGroup).toHaveBeenCalledWith(groups.activeGroup, 'height', RESIZE_STEP)
    expect(a.setSize).not.toHaveBeenCalled()
  })

  it('Editor focused: falls back to the chrome when the grid has no such split', () => {
    const height = makeLayout(PartId.EditorArea)
    const noSplit = makeGroups(false)
    exec(IncreaseViewHeightAction as never, height.mock, noSplit.mock)
    expect(noSplit.resizeGroup).toHaveBeenCalledWith(noSplit.activeGroup, 'height', RESIZE_STEP)
    expect(height.setSize).toHaveBeenCalledWith('panel', 300 - RESIZE_STEP)

    const width = makeLayout(PartId.EditorArea)
    const noSplit2 = makeGroups(false)
    exec(IncreaseViewWidthAction as never, width.mock, noSplit2.mock)
    expect(width.setSize).toHaveBeenCalledWith('secondarySidebar', 300 - RESIZE_STEP)
  })

  it('other parts focused: the editor group is never resized', () => {
    for (const part of [PartId.SideBar, PartId.SecondarySideBar, PartId.Panel]) {
      const layout = makeLayout(part)
      const groups = makeGroups(true)
      exec(IncreaseViewWidthAction as never, layout.mock, groups.mock)
      exec(IncreaseViewHeightAction as never, layout.mock, groups.mock)
      expect(groups.resizeGroup).not.toHaveBeenCalled()
    }
  })
})

describe('Keyboard resize of the focused view inside a stack', () => {
  it('SideBar focused: down grows the focused view, not the chrome', () => {
    const layout = makeLayout(PartId.SideBar)
    const registry = exec(IncreaseViewHeightAction as never, layout.mock, undefined, {
      focusedView: VIEW_ID,
    })
    expect(registry.resize).toHaveBeenCalledWith(VIEW_ID, RESIZE_STEP)
    expect(layout.setSize).not.toHaveBeenCalled()
  })

  it('SideBar focused: up shrinks the focused view', () => {
    const layout = makeLayout(PartId.SideBar)
    const registry = exec(DecreaseViewHeightAction as never, layout.mock, undefined, {
      focusedView: VIEW_ID,
    })
    expect(registry.resize).toHaveBeenCalledWith(VIEW_ID, -RESIZE_STEP)
    expect(layout.setSize).not.toHaveBeenCalled()
  })

  it('SecondarySideBar focused: down grows its focused view', () => {
    const layout = makeLayout(PartId.SecondarySideBar)
    const registry = exec(IncreaseViewHeightAction as never, layout.mock, undefined, {
      focusedView: VIEW_ID,
    })
    expect(registry.resize).toHaveBeenCalledWith(VIEW_ID, RESIZE_STEP)
    expect(layout.setSize).not.toHaveBeenCalled()
  })

  it('an empty focusedViewPane (part-level focus) keeps the vertical no-op', () => {
    const layout = makeLayout(PartId.SideBar)
    const registry = exec(IncreaseViewHeightAction as never, layout.mock, undefined, {
      focusedView: '',
    })
    expect(registry.resize).not.toHaveBeenCalled()
    expect(layout.setSize).not.toHaveBeenCalled()
  })

  it('a view no container could move stays a no-op instead of resizing the chrome', () => {
    const layout = makeLayout(PartId.SideBar)
    const unhandled = makeRegistry(false)
    const registry = exec(IncreaseViewHeightAction as never, layout.mock, undefined, {
      focusedView: VIEW_ID,
      registry: unhandled,
    })
    expect(registry.resize).toHaveBeenCalledWith(VIEW_ID, RESIZE_STEP)
    expect(layout.setSize).not.toHaveBeenCalled()
  })

  it('SideBar focused: width still resizes the sidebar itself', () => {
    const layout = makeLayout(PartId.SideBar)
    const registry = exec(IncreaseViewWidthAction as never, layout.mock, undefined, {
      focusedView: VIEW_ID,
    })
    expect(layout.setSize).toHaveBeenCalledWith('sidebar', 300 + RESIZE_STEP)
    expect(registry.resize).not.toHaveBeenCalled()
  })

  it('Panel focused: a focused view never hijacks the panel height', () => {
    const layout = makeLayout(PartId.Panel)
    const registry = exec(IncreaseViewHeightAction as never, layout.mock, undefined, {
      focusedView: VIEW_ID,
    })
    expect(layout.setSize).toHaveBeenCalledWith('panel', 300 + RESIZE_STEP)
    expect(registry.resize).not.toHaveBeenCalled()
  })

  it('Editor focused: a focused view never hijacks the editor resize', () => {
    const layout = makeLayout(PartId.EditorArea)
    const groups = makeGroups(true)
    const registry = exec(IncreaseViewHeightAction as never, layout.mock, groups.mock, {
      focusedView: VIEW_ID,
    })
    expect(groups.resizeGroup).toHaveBeenCalledWith(groups.activeGroup, 'height', RESIZE_STEP)
    expect(registry.resize).not.toHaveBeenCalled()
  })
})

describe('Move-editor chord rebinding (frees ctrl+alt+shift+arrows for resize)', () => {
  const disposables: IDisposable[] = []
  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('ctrl+k ctrl+shift+right resolves to MoveEditorToRightGroupAction', () => {
    disposables.push(registerAction2(MoveEditorToRightGroupAction))
    const ctx = new ContextKeyService()
    ctx.createKey('hasActiveEditor', true)
    try {
      expect(KeybindingsRegistry.resolveKeystroke('ctrl+k').kind).toBe('enter-chord')
      expect(
        KeybindingsRegistry.resolveKeystroke('ctrl+shift+right', ctx, ['ctrl+k']),
      ).toMatchObject({ kind: 'execute', command: MoveEditorToRightGroupAction.ID })
    } finally {
      ctx.dispose()
    }
  })

  it('resize width binding is on ctrl+alt+shift+right when a part is focused', () => {
    disposables.push(registerAction2(IncreaseViewWidthAction))
    const ctx = new ContextKeyService()
    ctx.createKey('sideBarFocus', true)
    try {
      expect(KeybindingsRegistry.resolveKeybinding('ctrl+alt+shift+right', ctx)).toBe(
        IncreaseViewWidthAction.ID,
      )
    } finally {
      ctx.dispose()
    }
  })
})
