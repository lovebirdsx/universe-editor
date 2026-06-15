import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
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

const DEFAULT_SIZES: LayoutSizes = { sidebar: 300, secondarySidebar: 300, panel: 300 }

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

describe('Keyboard resize of the focused part', () => {
  const disposables: IDisposable[] = []
  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  function exec(action: new () => never, layoutMock: never): void {
    const services = new ServiceCollection()
    services.set(ILayoutService, layoutMock)
    const inst = new InstantiationService(services)
    disposables.push(registerAction2(action))
    inst.invokeFunction((accessor) => {
      const id = (action as unknown as { ID: string }).ID
      CommandsRegistry.getCommand(id)!.handler(accessor)
    })
  }

  it('SideBar focused: right grows sidebar, left shrinks it', () => {
    const a = makeLayout(PartId.SideBar)
    exec(IncreaseViewWidthAction as never, a.mock)
    expect(a.setSize).toHaveBeenCalledWith('sidebar', 300 + RESIZE_STEP)

    const b = makeLayout(PartId.SideBar)
    exec(DecreaseViewWidthAction as never, b.mock)
    expect(b.setSize).toHaveBeenCalledWith('sidebar', 300 - RESIZE_STEP)
  })

  it('SideBar focused: vertical resize is a no-op', () => {
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

  it('Editor focused: width is a no-op when both sidebars are hidden', () => {
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
