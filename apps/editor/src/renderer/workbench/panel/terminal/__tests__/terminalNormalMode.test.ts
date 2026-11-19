import { describe, expect, it, vi } from 'vitest'
import type { VimSurfaceMode } from '@universe-editor/workbench-ui'
import {
  TerminalNormalModeController,
  type TerminalNormalModeTarget,
} from '../terminalNormalMode.js'

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

  it('switches the input method to English on entry and restores it on exit', async () => {
    const inputMethod = fakeInputMethod()
    const { controller } = makeController({ inputMethod })

    controller.enterNormalMode()
    await vi.waitFor(() => expect(inputMethod.switchToEnglish).toHaveBeenCalledTimes(1))

    controller.exitNormalMode()
    await vi.waitFor(() => expect(inputMethod.restore).toHaveBeenCalledTimes(1))
  })

  it('honours vim.autoSwitchInputMethod=false', async () => {
    const inputMethod = fakeInputMethod()
    const { controller } = makeController({ inputMethod, autoSwitch: () => false })

    controller.enterNormalMode()
    controller.exitNormalMode()
    await Promise.resolve()

    expect(inputMethod.switchToEnglish).not.toHaveBeenCalled()
    expect(inputMethod.restore).not.toHaveBeenCalled()
  })
})
