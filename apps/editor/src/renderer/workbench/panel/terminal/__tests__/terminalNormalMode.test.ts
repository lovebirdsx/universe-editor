import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VimSurfaceMode } from '@universe-editor/workbench-ui'
import { releaseInputMethod, requestInputMethod } from '../../../editor/vim/vimInputMethod.js'
import {
  TerminalNormalModeController,
  createTerminalSurfaceActions,
  type TerminalNormalModeTarget,
} from '../terminalNormalMode.js'

// The window-wide owner model lives in editor/vim/vimInputMethod.ts (own tests);
// here only the terminal's use of it is asserted.
vi.mock('../../../editor/vim/vimInputMethod.js', () => ({
  requestInputMethod: vi.fn(),
  releaseInputMethod: vi.fn(),
}))

beforeEach(() => {
  vi.mocked(requestInputMethod).mockClear()
  vi.mocked(releaseInputMethod).mockClear()
})

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

interface FakeActive {
  cursorY: number
  viewportY: number
  baseY: number
  length: number
}

class FakeTerminal implements TerminalNormalModeTarget {
  rows = 10
  selectionText = ''
  focused = 0
  scrollLinesCalls: number[] = []
  scrollToLineCalls: number[] = []
  private _active: FakeActive = { cursorY: 9, viewportY: 90, baseY: 90, length: 100 }
  private _selection: { start: number; end: number } | undefined

  get buffer(): { readonly active: FakeActive } {
    return { active: this._active }
  }

  setViewport(
    viewportY: number,
    options: { cursorY?: number; baseY?: number; length?: number } = {},
  ): void {
    this._active = {
      ...this._active,
      viewportY,
      ...(options.cursorY !== undefined ? { cursorY: options.cursorY } : {}),
      ...(options.baseY !== undefined ? { baseY: options.baseY } : {}),
      ...(options.length !== undefined ? { length: options.length } : {}),
    }
  }

  get selection(): { start: number; end: number } | undefined {
    return this._selection
  }

  scrollLines(amount: number): void {
    this.scrollLinesCalls.push(amount)
    this._active = {
      ...this._active,
      viewportY: clamp(this._active.viewportY + amount, 0, this._active.baseY),
    }
  }

  scrollToLine(line: number): void {
    this.scrollToLineCalls.push(line)
    this._active = { ...this._active, viewportY: clamp(line, 0, this._active.baseY) }
  }

  selectLines(start: number, end: number): void {
    this._selection = { start, end }
  }

  getSelection(): string {
    return this.selectionText
  }

  hasSelection(): boolean {
    return this._selection !== undefined
  }

  clearSelection(): void {
    this._selection = undefined
    this.selectionText = ''
  }

  focus(): void {
    this.focused++
  }
}

function fakeVimService(enabled = true) {
  const modes = new Map<string, VimSurfaceMode>()
  const state = { enabled }
  return {
    modes,
    state,
    getEnabled: () => state.enabled,
    isSurfaceEnabled: () => true,
    getMode: (key: string, fallback: VimSurfaceMode) => modes.get(key) ?? fallback,
    setMode: vi.fn((key: string, mode: VimSurfaceMode) => {
      modes.set(key, mode)
    }),
  }
}

function fakeInputMethod() {
  return {
    _serviceBrand: undefined,
    switchToEnglish: vi.fn(async () => true),
    restore: vi.fn(async () => {}),
  }
}

function makeController(
  overrides: {
    enabled?: boolean
    inputMethod?: ReturnType<typeof fakeInputMethod>
    autoSwitch?: () => boolean
  } = {},
) {
  const target = new FakeTerminal()
  const vim = fakeVimService(overrides.enabled ?? true)
  const copy = vi.fn(async () => {})
  const inputMethod = overrides.inputMethod
  const controller = new TerminalNormalModeController({
    surfaceKey: 'terminal:t1',
    target,
    getElement: () => null,
    vimModeService: vim,
    ...(inputMethod !== undefined ? { inputMethodService: inputMethod } : {}),
    ...(overrides.autoSwitch !== undefined ? { autoSwitchInputMethod: overrides.autoSwitch } : {}),
    copySelection: copy,
  })
  return { controller, target, vim, copy }
}

describe('TerminalNormalModeController', () => {
  it('enters terminal-normal, focuses the terminal and remembers the surface', () => {
    const { controller, target, vim } = makeController()

    expect(controller.enterNormalMode()).toBe(true)
    expect(target.focused).toBe(1)
    expect(vim.modes.get('terminal:t1')).toBe('terminal-normal')
    expect(controller.isNormalMode()).toBe(true)
  })

  it('does nothing when the global Vim switch is off', () => {
    const { controller, target, vim } = makeController({ enabled: false })

    expect(controller.enterNormalMode()).toBe(false)
    expect(vim.setMode).not.toHaveBeenCalled()
    expect(target.focused).toBe(0)
    expect(controller.isNormalMode()).toBe(false)
  })

  it('leaves to insert and keeps focus in the terminal', () => {
    const { controller, target, vim } = makeController()
    controller.enterNormalMode()

    expect(controller.exitNormalMode()).toBe(true)
    expect(vim.modes.get('terminal:t1')).toBe('insert')
    expect(target.focused).toBe(2)
  })

  it('Escape with a selection clears it and stays in Normal mode', () => {
    const { controller, vim } = makeController()
    controller.enterNormalMode()
    controller.startSelection()

    expect(controller.exitNormalMode()).toBe(false)
    expect(vim.modes.get('terminal:t1')).toBe('terminal-normal')
    expect(controller.isNormalMode()).toBe(true)
  })

  it('scrolls lines with the count applied in both directions', () => {
    const { controller, target } = makeController()

    controller.scrollLines(1, 3)
    controller.scrollLines(-1, 2)

    expect(target.scrollLinesCalls).toEqual([3, -2])
  })

  it('scrolls half pages and full pages based on the viewport rows', () => {
    const { controller, target } = makeController()

    controller.scrollHalfPage('down', 2)
    controller.scrollPage('up')

    expect(target.scrollLinesCalls).toEqual([10, -10])
  })

  it('gg and G jump to the first and last buffer lines', () => {
    const { controller, target } = makeController()

    controller.scrollToTop()
    controller.scrollToBottom()

    expect(target.scrollToLineCalls).toEqual([0, 90])
  })

  it('anchors a new selection on the visible cursor line', () => {
    const { controller, target } = makeController()
    target.setViewport(90, { cursorY: 5 })
    controller.enterNormalMode()

    controller.startSelection()

    expect(target.selection).toEqual({ start: 95, end: 95 })
  })

  it('falls back to the last visible line when the cursor is scrolled out', () => {
    const { controller, target } = makeController()
    target.setViewport(20, { cursorY: 5 })
    controller.enterNormalMode()

    controller.startSelection()

    expect(target.selection).toEqual({ start: 29, end: 29 })
  })

  it('extends a linewise selection with j/k and keeps the range ordered', () => {
    const { controller, target } = makeController()
    target.setViewport(90, { cursorY: 5 })
    controller.enterNormalMode()
    controller.startSelection()

    controller.scrollLines(-1, 2)
    expect(target.selection).toEqual({ start: 93, end: 95 })

    controller.scrollLines(1, 5)
    expect(target.selection).toEqual({ start: 95, end: 98 })
  })

  it('reveals the selection end when extending past the viewport', () => {
    const { controller, target } = makeController()
    target.setViewport(90, { cursorY: 5 })
    controller.enterNormalMode()
    controller.startSelection()

    controller.scrollLines(-1, 10)

    expect(target.selection).toEqual({ start: 85, end: 95 })
    expect(target.scrollToLineCalls.at(-1)).toBe(85)
  })

  it('gg/G extend the selection to the buffer edges', () => {
    const { controller, target } = makeController()
    target.setViewport(90, { cursorY: 5 })
    controller.enterNormalMode()
    controller.startSelection()

    controller.scrollToTop()
    expect(target.selection).toEqual({ start: 0, end: 95 })

    controller.scrollToBottom()
    expect(target.selection).toEqual({ start: 95, end: 99 })
  })

  it('copies the selected text, clears it and reports success', async () => {
    const { controller, target, copy } = makeController()
    target.setViewport(90, { cursorY: 5 })
    target.selectionText = 'echo hello'
    controller.enterNormalMode()
    controller.startSelection()

    await expect(controller.copySelection()).resolves.toBe(true)
    expect(copy).toHaveBeenCalledTimes(1)
    expect(target.selection).toBeUndefined()
  })

  it('does not copy or report success without a selection', async () => {
    const { controller, copy } = makeController()

    await expect(controller.copySelection()).resolves.toBe(false)
    expect(copy).not.toHaveBeenCalled()
  })

  it('claims English on entry and gives it back on exit, as the terminal owner', () => {
    const inputMethod = fakeInputMethod()
    const { controller } = makeController({ inputMethod })

    controller.enterNormalMode()
    expect(requestInputMethod).toHaveBeenLastCalledWith(controller, inputMethod, 'english')

    controller.exitNormalMode()
    expect(releaseInputMethod).toHaveBeenLastCalledWith(controller, inputMethod)
  })

  it('honours vim.autoSwitchInputMethod=false', () => {
    const inputMethod = fakeInputMethod()
    const { controller } = makeController({ inputMethod, autoSwitch: () => false })

    controller.enterNormalMode()
    controller.exitNormalMode()

    expect(requestInputMethod).not.toHaveBeenCalled()
  })

  it('hands the input method back when focus leaves and re-asserts it on return', () => {
    const inputMethod = fakeInputMethod()
    const { controller, vim } = makeController({ inputMethod })
    controller.enterNormalMode()
    vi.mocked(requestInputMethod).mockClear()

    controller.handleFocusOut()
    expect(releaseInputMethod).toHaveBeenLastCalledWith(controller, inputMethod)
    expect(requestInputMethod).not.toHaveBeenCalled()
    // Leaving focus is not leaving Normal mode.
    expect(vim.modes.get('terminal:t1')).toBe('terminal-normal')

    controller.handleFocusIn()
    expect(requestInputMethod).toHaveBeenLastCalledWith(controller, inputMethod, 'english')
  })

  it('never claims English for a terminal that is focused but in Insert mode', () => {
    const inputMethod = fakeInputMethod()
    const { controller } = makeController({ inputMethod })

    controller.handleFocusIn()

    expect(requestInputMethod).not.toHaveBeenCalled()
  })

  it('re-asserts English after a remount when the remembered mode is still Normal', () => {
    const inputMethod = fakeInputMethod()
    const first = makeController({ inputMethod })
    first.controller.enterNormalMode()

    // Reparent: the old view detaches, the mode memory stays, a new controller
    // attaches to the same surface key and sees focus come back.
    first.controller.dispose()
    expect(first.vim.modes.get('terminal:t1')).toBe('terminal-normal')
    expect(releaseInputMethod).toHaveBeenLastCalledWith(first.controller, inputMethod)

    const second = new TerminalNormalModeController({
      surfaceKey: 'terminal:t1',
      target: first.target,
      vimModeService: first.vim,
      inputMethodService: inputMethod,
      copySelection: first.copy,
    })
    expect(second.isNormalMode()).toBe(true)
    second.handleFocusIn()
    expect(requestInputMethod).toHaveBeenLastCalledWith(second, inputMethod, 'english')
  })

  it('follows a runtime vim.enabled / mode change through syncInputMethod', () => {
    const inputMethod = fakeInputMethod()
    const { controller, vim } = makeController({ inputMethod })
    controller.enterNormalMode()
    vi.mocked(releaseInputMethod).mockClear()

    vim.state.enabled = false
    controller.syncInputMethod()

    expect(releaseInputMethod).toHaveBeenLastCalledWith(controller, inputMethod)
  })

  it('NG jumps to buffer line N, centred in the viewport and clamped', () => {
    const { controller, target } = makeController()

    controller.scrollToBufferLine(50)
    controller.scrollToBufferLine(1)
    controller.scrollToBufferLine(9999)

    // rows = 10 -> half = 5; line 50 is index 49, so the viewport starts at 44.
    // Line 1 clamps at 0; past the end it clamps to the last line (index 99 -> 94).
    expect(target.scrollToLineCalls).toEqual([44, 0, 94])
  })

  it('NG while selecting extends the selection to that line', () => {
    const { controller, target } = makeController()
    target.setViewport(90, { cursorY: 5 })
    controller.enterNormalMode()
    controller.startSelection()

    controller.scrollToBufferLine(80)

    expect(target.selection).toEqual({ start: 79, end: 95 })
  })
})

describe('createTerminalSurfaceActions', () => {
  it('maps the generic list.* contract onto the Normal-mode controller', () => {
    const { controller, target } = makeController()
    const actions = createTerminalSurfaceActions(controller)

    actions.move?.('down', 3)
    actions.move?.('up', 2)
    actions.move?.('left', 5)
    actions.scrollViewport?.('down', 4)
    actions.scrollViewport?.('up', 1)
    actions.page?.('down', 1)
    actions.page?.('up', 2)
    expect(target.scrollLinesCalls).toEqual([3, -2, 4, -1, 5, -10])

    actions.first?.(0)
    actions.last?.(0)
    expect(target.scrollToLineCalls).toEqual([0, 90])
  })

  it('treats a count on gg / G as the 1-based buffer line', () => {
    const { controller, target } = makeController()
    const actions = createTerminalSurfaceActions(controller)

    actions.first?.(1)
    actions.last?.(1)
    actions.last?.(50)

    expect(target.scrollToLineCalls).toEqual([0, 0, 44])
  })

  it('escape leaves Normal mode, or just clears a selection first', () => {
    const { controller, vim } = makeController()
    const actions = createTerminalSurfaceActions(controller)
    controller.enterNormalMode()
    controller.startSelection()

    actions.escape?.(1)
    expect(vim.modes.get('terminal:t1')).toBe('terminal-normal')
    actions.escape?.(1)
    expect(vim.modes.get('terminal:t1')).toBe('insert')
  })
})
