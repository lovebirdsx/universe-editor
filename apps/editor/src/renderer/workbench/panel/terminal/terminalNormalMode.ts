/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Terminal Normal Mode — Vim's Normal mode over an xterm scrollback.
 *
 *  The terminal has no text cursor to move, so Normal mode is a viewport/selection
 *  layer: j/k scroll lines, Ctrl+D/U half pages, Ctrl+F/B pages, gg/G jump, and
 *  `v` starts a linewise selection that j/k extends. The dispatcher routes keys
 *  through the Vim keymap, so this class owns no DOM event and no command
 *  registry. Motion reaches it through the generic `list.*` commands via
 *  {@link createTerminalSurfaceActions}; only Ctrl+F/B paging, selection and the
 *  mode switches are terminal-specific commands.
 *
 *  Input method: English is held while this terminal is in Normal mode AND has
 *  focus, through the window-wide owner API in `editor/vim/vimInputMethod.ts`
 *  (owner = this controller instance, so only the terminal that took English can give it back).
 *  The host reports focus changes via `handleFocusIn/Out`; `dispose()` is a
 *  detach (reparent / unmount) — it releases the input method but leaves the
 *  remembered mode alone, since the xterm holder and the mode outlive the view.
 *
 *  Pure apart from the injected terminal target and the input-method module, so
 *  the entire state machine is unit-testable with a fake buffer.
 *--------------------------------------------------------------------------------------------*/

import type { IVimSurfaceActions, VimSurfaceMode } from '@universe-editor/workbench-ui'
import type { IVimModeService } from '../../../services/vim/vimModeService.js'
import type { IVimInputMethodService } from '../../../../shared/ipc/vimInputMethodService.js'
import { releaseInputMethod, requestInputMethod } from '../../editor/vim/vimInputMethod.js'

export interface TerminalNormalModeBufferState {
  /** Cursor row relative to the bottom page (0 = `baseY`). */
  readonly cursorY: number
  /** Absolute buffer line at the top of the viewport. */
  readonly viewportY: number
  /** Absolute buffer line at the top of the bottom page. */
  readonly baseY: number
  /** Total buffer lines. */
  readonly length: number
}

/** The subset of xterm's `Terminal` this layer touches. Structural, so a fake works. */
export interface TerminalNormalModeTarget {
  readonly rows: number
  readonly buffer: { readonly active: TerminalNormalModeBufferState }
  scrollLines(amount: number): void
  scrollToLine(line: number): void
  /** `end` is inclusive, matching xterm. */
  selectLines(start: number, end: number): void
  getSelection(): string
  hasSelection(): boolean
  clearSelection(): void
  focus(): void
}

export interface TerminalNormalModeCopyTarget {
  hasSelection(): boolean
  getSelection(): string
}

export type TerminalNormalModeCopy = (target: TerminalNormalModeCopyTarget) => Promise<void>

export interface TerminalNormalModeOptions {
  readonly surfaceKey: string
  readonly target: TerminalNormalModeTarget
  /** DOM host of the terminal, used to find the controller that owns focus. */
  readonly getElement?: (() => HTMLElement | null) | undefined
  readonly vimModeService: Pick<
    IVimModeService,
    'getEnabled' | 'getMode' | 'setMode' | 'isSurfaceEnabled'
  >
  readonly inputMethodService?: IVimInputMethodService | undefined
  /** Reads `vim.autoSwitchInputMethod`; defaults to enabled when omitted. */
  readonly autoSwitchInputMethod?: (() => boolean) | undefined
  readonly copySelection: TerminalNormalModeCopy
}

const NORMAL_MODE: VimSurfaceMode = 'terminal-normal'
const INSERT_MODE: VimSurfaceMode = 'insert'

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * The terminal's side of the generic Vim surface contract: `list.focusDown`,
 * `list.pageDown`, `list.scrollViewportDown` ... land here, so the keymap reuses
 * the list command ids instead of a parallel `normalScroll*` family.
 */
export function createTerminalSurfaceActions(
  controller: Pick<
    TerminalNormalModeController,
    | 'scrollLines'
    | 'scrollHalfPage'
    | 'scrollToTop'
    | 'scrollToBottom'
    | 'scrollToBufferLine'
    | 'exitNormalMode'
  >,
): IVimSurfaceActions {
  return {
    move: (direction, count) => {
      if (direction === 'down') controller.scrollLines(1, count)
      else if (direction === 'up') controller.scrollLines(-1, count)
    },
    scrollViewport: (direction, count) =>
      controller.scrollLines(direction === 'down' ? 1 : -1, count),
    page: (direction, count) => controller.scrollHalfPage(direction, count),
    // count 0 = none typed (`gg` / `G`); n >= 1 = buffer line n, like Vim's `nG`.
    first: (count) =>
      count >= 1 ? controller.scrollToBufferLine(count) : controller.scrollToTop(),
    last: (count) =>
      count >= 1 ? controller.scrollToBufferLine(count) : controller.scrollToBottom(),
    escape: () => {
      controller.exitNormalMode()
    },
  }
}

export class TerminalNormalModeController {
  private readonly _options: TerminalNormalModeOptions
  private _selecting = false
  private _anchorLine = 0
  private _endLine = 0
  /** DOM focus is inside this terminal; English is only held while it is. */
  private _focused = false

  constructor(options: TerminalNormalModeOptions) {
    this._options = options
  }

  get surfaceKey(): string {
    return this._options.surfaceKey
  }

  getElement(): HTMLElement | null {
    return this._options.getElement?.() ?? null
  }

  isNormalMode(): boolean {
    const vim = this._options.vimModeService
    return (
      vim.getEnabled() &&
      vim.isSurfaceEnabled('terminal') &&
      vim.getMode(this._options.surfaceKey, INSERT_MODE) === NORMAL_MODE
    )
  }

  /** Enter from insert. No-op when the global Vim switch is off. */
  enterNormalMode(): boolean {
    const vim = this._options.vimModeService
    if (!vim.getEnabled() || !vim.isSurfaceEnabled('terminal')) return false
    if (this.isNormalMode()) {
      this._focused = true
      this.syncInputMethod()
      this._options.target.focus()
      return true
    }
    this._cancelSelectionState()
    vim.setMode(this._options.surfaceKey, NORMAL_MODE)
    // Entering is only ever requested from the focused terminal (and focuses it).
    this._focused = true
    this.syncInputMethod()
    this._options.target.focus()
    return true
  }

  /**
   * Escape back to insert. An active (or mouse-made) selection is cleared first
   * and Normal mode is kept — that is Vim's "Esc leaves visual mode" step, which
   * the shared keymap currently expresses through the same command as `i`.
   */
  exitNormalMode(): boolean {
    if (!this.isNormalMode()) return false
    if (this._selecting || this._options.target.hasSelection()) {
      this.cancelSelection()
      return false
    }
    this._cancelSelectionState()
    this._options.vimModeService.setMode(this._options.surfaceKey, INSERT_MODE)
    this.syncInputMethod()
    this._options.target.focus()
    return true
  }

  /** DOM focus entered the terminal (also: the window regained focus). */
  handleFocusIn(): void {
    this._focused = true
    this.syncInputMethod()
  }

  /** DOM focus left the terminal (also: the window lost focus, e.g. Alt+Tab). */
  handleFocusOut(): void {
    this._focused = false
    this.syncInputMethod()
  }

  /** Drop a linewise selection without leaving Normal mode. */
  cancelSelection(): void {
    this._cancelSelectionState()
    this._options.target.clearSelection()
  }

  /** Scroll by `amount * count` lines (positive = down/toward newer output). */
  scrollLines(amount: number, count = 1): void {
    const lines = amount * Math.max(1, count)
    this.moveBy(lines)
  }

  scrollHalfPage(direction: 'up' | 'down', count = 1): void {
    const target = this._options.target
    const lines = Math.max(1, Math.floor(target.rows / 2)) * Math.max(1, count)
    this.moveBy(direction === 'down' ? lines : -lines)
  }

  scrollPage(direction: 'up' | 'down', count = 1): void {
    const target = this._options.target
    const lines = Math.max(1, target.rows) * Math.max(1, count)
    this.moveBy(direction === 'down' ? lines : -lines)
  }

  scrollToTop(): void {
    if (this._selecting) {
      this.extendSelectionTo(0)
      return
    }
    this._options.target.scrollToLine(0)
  }

  scrollToBottom(): void {
    if (this._selecting) {
      this.extendSelectionTo(this._lastLine())
      return
    }
    this._options.target.scrollToLine(this._options.target.buffer.active.baseY)
  }

  /**
   * `NG`: jump to buffer line `line` (1-based, clamped). With no text cursor to
   * land on, the line is centred in the viewport like Vim does for a far jump;
   * while selecting it extends the selection to that line instead.
   */
  scrollToBufferLine(line: number): void {
    const index = clamp(Math.floor(line) - 1, 0, this._lastLine())
    if (this._selecting) {
      this.extendSelectionTo(index)
      return
    }
    const target = this._options.target
    target.scrollToLine(Math.max(0, index - Math.floor(target.rows / 2)))
  }

  /**
   * Start a linewise selection at the cursor line when it is visible, otherwise
   * at the last visible line (the user is scrolled up in history and the shell
   * cursor is below the viewport).
   */
  startSelection(): void {
    if (!this.isNormalMode()) return
    const active = this._options.target.buffer.active
    const lastVisible = Math.min(this._lastLine(), active.viewportY + this._options.target.rows - 1)
    const cursorLine = active.baseY + active.cursorY
    const anchor =
      cursorLine >= active.viewportY && cursorLine <= lastVisible ? cursorLine : lastVisible
    this._selecting = true
    this._anchorLine = clamp(anchor, 0, this._lastLine())
    this._endLine = this._anchorLine
    this._applySelection()
  }

  /** Copy the current selection and clear it. False when there was nothing to copy. */
  async copySelection(): Promise<boolean> {
    const target = this._options.target
    if (!this._selecting && !target.hasSelection()) return false
    if (!target.hasSelection() || target.getSelection().length === 0) {
      this.cancelSelection()
      return false
    }
    try {
      await this._options.copySelection(target)
    } catch {
      return false
    }
    this.cancelSelection()
    return true
  }

  /**
   * Detach from the view. The remembered mode is kept on purpose: the view is
   * recreated when the terminal moves between panel and editor area, and the
   * mode is only dropped (`forgetSurface`) when the terminal itself is removed.
   */
  dispose(): void {
    this._cancelSelectionState()
    this._focused = false
    this.syncInputMethod()
  }

  private _lastLine(): number {
    return Math.max(0, this._options.target.buffer.active.length - 1)
  }

  private moveBy(lines: number): void {
    if (lines === 0) return
    if (this._selecting) {
      this.extendSelectionTo(this._endLine + lines)
      return
    }
    this._options.target.scrollLines(lines)
  }

  private extendSelectionTo(line: number): void {
    this._selecting = true
    this._endLine = clamp(line, 0, this._lastLine())
    this._applySelection()
    this._reveal(this._endLine)
  }

  private _applySelection(): void {
    const start = Math.min(this._anchorLine, this._endLine)
    const end = Math.max(this._anchorLine, this._endLine)
    this._options.target.selectLines(start, end)
  }

  private _reveal(line: number): void {
    const target = this._options.target
    const active = target.buffer.active
    if (line < active.viewportY) {
      target.scrollToLine(line)
    } else if (line > active.viewportY + target.rows - 1) {
      target.scrollToLine(Math.max(0, line - target.rows + 1))
    }
  }

  private _cancelSelectionState(): void {
    this._selecting = false
    this._anchorLine = 0
    this._endLine = 0
  }

  /** Re-derive the input method from mode + focus + config; idempotent. */
  syncInputMethod(): void {
    const service = this._options.inputMethodService
    if (service === undefined) return
    const english =
      this._focused && this.isNormalMode() && this._options.autoSwitchInputMethod?.() !== false
    if (english) requestInputMethod(this, service, 'english')
    else releaseInputMethod(this, service)
  }
}
