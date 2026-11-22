/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Vim mode — the pure, DOM-free core. Everything here is a plain data shape or a
 *  reducer; Monaco lives only behind the `VimEditor` structural interface so the
 *  keymap and motions can be unit-tested under node without an editor instance.
 *--------------------------------------------------------------------------------------------*/

import type { monaco } from '../monaco/MonacoLoader.js'

export type VimMode = 'normal' | 'insert'

export type VimOperator = 'd' | 'y' | 'c'

/** Direction of a `/` or `?` search. */
export type VimSearchDirection = 'forward' | 'backward'

/** A motion is linewise when it targets whole lines (j/k/gg/G/{/}), charwise otherwise. */
export type VimMotionKind = 'linewise' | 'charwise'

export type VimMotion =
  | 'h'
  | 'j'
  | 'k'
  | 'l'
  | 'w'
  | 'b'
  | 'e'
  | 'W'
  | 'B'
  | 'E'
  | '0'
  | '^'
  | '$'
  | 'gg'
  | 'G'
  | 'enter'
  | '{'
  | '}'
  | 'pageDown'
  | 'pageUp'
  | 'halfPageDown'
  | 'halfPageUp'

export interface VimState {
  readonly mode: VimMode
  /** Accumulated count; 0 means "none entered". */
  readonly count: number
  readonly pendingOperator: VimOperator | null
  /** `g` was pressed and we are waiting for the command key (`gg`, `gd`, …). */
  readonly pendingG: boolean
  /** `z` was pressed and we are waiting for `z` / `t` / `b`. */
  readonly pendingZ: boolean
  /** `[` or `]` was pressed and we are waiting for the navigation key. */
  readonly pendingBracket: '[' | ']' | null
  /** `>` or `<` was pressed and we are waiting for the same key (`>>`, `<<`). */
  readonly pendingIndent: '>' | '<' | null
  /**
   * Whether a digit has been typed *after* the pending operator. Vim only lets
   * `0` act as a count digit once a count has started there (`d10w`); a `0`
   * that follows the operator directly is the line-start motion (`3d0`).
   */
  readonly countAfterOperator: boolean
}

export const INITIAL_VIM_STATE: VimState = {
  mode: 'normal',
  count: 0,
  pendingOperator: null,
  pendingG: false,
  pendingZ: false,
  pendingBracket: null,
  pendingIndent: null,
  countAfterOperator: false,
}

export type VimInsertPlacement =
  | 'before'
  | 'after'
  | 'line-start'
  | 'line-end'
  | 'new-line-below'
  | 'new-line-above'

export type VimCommand =
  | { readonly type: 'motion'; readonly motion: VimMotion; readonly count: number }
  | {
      readonly type: 'operator'
      readonly operator: VimOperator
      readonly motion: VimMotion
      readonly count: number
    }
  /** `dd`/`yy`: `count` whole lines starting at the cursor. */
  | { readonly type: 'linewise'; readonly operator: VimOperator; readonly count: number }
  | { readonly type: 'enter-insert'; readonly placement: VimInsertPlacement }
  | { readonly type: 'delete-char'; readonly count: number; readonly backward: boolean }
  | { readonly type: 'paste'; readonly count: number; readonly before: boolean }
  | { readonly type: 'undo' }
  | { readonly type: 'join-lines'; readonly count: number }
  /** `/` and `?`: open the search box in the given direction. */
  | {
      readonly type: 'search-open'
      readonly direction: VimSearchDirection
      readonly count: number
    }
  /** `n` and `N`: repeat the last search; `reverse` flips its direction. */
  | { readonly type: 'search-repeat'; readonly reverse: boolean; readonly count: number }
  /** `*` and `#`: search for the word under the cursor. */
  | {
      readonly type: 'search-word'
      readonly direction: VimSearchDirection
      readonly count: number
    }
  /** Normal-mode Escape: drop persistent `hlsearch` highlights (`:nohlsearch`). */
  | { readonly type: 'search-highlight-clear' }
  /** Monaco editor action (`gd`, `%`, `o`, …); executed through `editor.trigger`. */
  | { readonly type: 'editor-command'; readonly commandId: string }
  /** Workbench command (`]c`, `[c`); executed through the injected command service. */
  | {
      readonly type: 'platform-command'
      readonly commandId: string
      readonly count: number
    }
  /** `>>` and `<<`: indent/outdent the current line. */
  | {
      readonly type: 'indent'
      readonly direction: 'in' | 'out'
      readonly count: number
    }
  /** `s`: delete characters under the cursor and enter Insert. */
  | { readonly type: 'substitute-char'; readonly count: number }
  /** `Ctrl+E` / `Ctrl+Y`: scroll the viewport by screen lines, keeping the cursor visible. */
  | {
      readonly type: 'scroll-viewport'
      readonly direction: 'up' | 'down'
      readonly count: number
    }
  /** `zz` / `zt` / `zb`: place a line at the center / top / bottom of the viewport. */
  | {
      readonly type: 'reveal-line'
      readonly at: 'top' | 'center' | 'bottom'
      /** `null` means "the cursor line"; a count is a line number, like `[count]zt`. */
      readonly line: number | null
    }
  /** `H` / `M` / `L`: jump to a visible line without moving the viewport. */
  | {
      readonly type: 'goto-viewport-line'
      readonly at: 'top' | 'middle' | 'bottom'
      readonly count: number
    }
  /** `[z` / `]z`: jump to the start/end of the current or enclosing fold. */
  | { readonly type: 'fold-goto'; readonly edge: 'start' | 'end' }

export interface VimKeyInput {
  readonly key: string
  readonly ctrl: boolean
  readonly alt: boolean
  readonly meta: boolean
  readonly shift: boolean
  readonly repeat: boolean
}

export interface VimKeyResult {
  readonly state: VimState
  readonly command: VimCommand | null
  /**
   * Whether the stroke belongs to Vim and must be swallowed. Normal-mode
   * printable keys are always swallowed even when they map to no command, so a
   * stray `q` never leaks into the buffer.
   */
  readonly handled: boolean
}

export interface VimPosition {
  readonly line: number
  readonly column: number
}

/** Monaco's `IPosition` shape (1-based line/column). */
export interface VimMonacoPosition {
  readonly lineNumber: number
  readonly column: number
}

export interface VimRange {
  readonly startLineNumber: number
  readonly startColumn: number
  readonly endLineNumber: number
  readonly endColumn: number
}

/** Monaco's `ISelection` shape: a range plus the primary cursor position. */
export interface VimSelection {
  readonly selectionStartLineNumber: number
  readonly selectionStartColumn: number
  readonly positionLineNumber: number
  readonly positionColumn: number
}

export interface VimEdit {
  readonly range: VimRange
  readonly text: string | null
}

/** The slice of `monaco.editor.ITextModel` the motions need. */
export interface VimTextModel {
  getLineCount(): number
  getLineContent(lineNumber: number): string
  getValueInRange(range: VimRange): string
  getEOL(): string
}

/**
 * The slice of `monaco.editor.IStandaloneCodeEditor` the controller needs.
 * `monaco.editor.ICodeEditor` satisfies it structurally.
 */
export interface VimEditor {
  getModel(): VimTextModel | null
  getSelections(): readonly VimRange[] | null
  setPosition(position: VimMonacoPosition, source?: string): void
  setSelections(selections: VimSelection[], source?: string): void
  executeEdits(source: string, edits: VimEdit[]): boolean
  pushUndoStop(): boolean
  trigger(source: string, handlerId: string, payload: unknown): void
  revealPositionInCenterIfOutsideViewport(position: VimMonacoPosition, scrollType?: number): void
  /** Content Y of a line's top edge; used for exact `zt` / `zb` alignment. */
  getTopForLineNumber(lineNumber: number): number
  /** Content Y of a line's bottom edge. */
  getBottomForLineNumber(lineNumber: number): number
  setScrollTop(scrollTop: number, scrollType?: number): void
  getLayoutInfo(): { height: number }
  /** Lets `zt`/`H` subtract the sticky-scroll overlay without importing Monaco. */
  getContribution?<T extends monaco.editor.IEditorContribution>(id: string): T | null
  getVisibleRanges(): readonly VimRange[]
  getContainerDomNode(): HTMLElement
  onDidFocusEditorText(listener: () => void): { dispose(): void }
  onDidBlurEditorText(listener: () => void): { dispose(): void }
  onDidChangeModel(listener: () => void): { dispose(): void }
  onDidChangeModelContent(listener: () => void): { dispose(): void }
  focus(): void
  addOverlayWidget(widget: monaco.editor.IOverlayWidget): void
  removeOverlayWidget(widget: monaco.editor.IOverlayWidget): void
  createDecorationsCollection(
    decorations?: monaco.editor.IModelDeltaDecoration[],
  ): monaco.editor.IEditorDecorationsCollection
}
