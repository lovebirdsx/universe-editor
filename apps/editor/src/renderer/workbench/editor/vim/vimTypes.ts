/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Vim mode — the pure, DOM-free core. Everything here is a plain data shape or a
 *  reducer; Monaco lives only behind the `VimEditor` structural interface so the
 *  keymap and motions can be unit-tested under node without an editor instance.
 *
 *  Extension points (see the file each one lives in):
 *  - new motion        → one entry in `VIM_MOTIONS` (vimMotions.ts)
 *  - new operator      → one entry in `VIM_OPERATORS` (vimOperators.ts)
 *  - new text object   → one entry in `VIM_TEXT_OBJECTS` (vimTextObjects.ts)
 *  - new prefix key    → `PREFIX_TABLES` / `PREFIX_STARTERS` (vimKeymap.ts)
 *  - new plain command → `SIMPLE_COMMANDS` (vimKeymap.ts) + a handler in `COMMAND_HANDLERS`
 *  - new Visual action → `VISUAL_ACTION_KEYS` (vimVisual.ts) + its branch in vimEdits.ts
 *  Session-wide state (registers, `.` repeat, `;`/`,` find) lives in vimRegisters.ts /
 *  vimSession.ts; per-editor Visual state lives in the controller.
 *--------------------------------------------------------------------------------------------*/

import type { monaco } from '../monaco/MonacoLoader.js'

export type VimVisualMode = 'visual' | 'visual-line' | 'visual-block'

export type VimMode = 'normal' | 'insert' | VimVisualMode

export function isVisualMode(mode: VimMode): mode is VimVisualMode {
  return mode === 'visual' || mode === 'visual-line' || mode === 'visual-block'
}

/**
 * Operators combine with a motion (`dw`), a text object (`ciw`), a doubled key
 * (`dd`) or a count of lines (`3>>`). `g~` / `gu` / `gU` are the case operators.
 */
export type VimOperator = 'd' | 'y' | 'c' | '>' | '<' | 'g~' | 'gu' | 'gU'

/** Direction of a `/` or `?` search. */
export type VimSearchDirection = 'forward' | 'backward'

/**
 * How an operator turns a motion's destination into a range: `linewise` takes
 * whole lines, `inclusive` includes the destination character, `exclusive`
 * stops just before it.
 */
export type VimMotionKind = 'linewise' | 'inclusive' | 'exclusive'

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
  | 'f'
  | 'F'
  | 't'
  | 'T'
  | ';'
  | ','
  | '%'

/** The four motions that take a character argument (`fx`, `Tx`). */
export type VimFindMotion = 'f' | 'F' | 't' | 'T'

/** What `;` and `,` repeat. */
export interface VimFindState {
  readonly motion: VimFindMotion
  readonly char: string
}

/** Extra input a motion may need beyond the cursor: the typed character, the last `f`/`t`. */
export interface VimMotionArgs {
  readonly char?: string
  readonly lastFind?: VimFindState | null
}

/** Canonical id of a text object — the key of its first spelling (`)` and `b` both mean `(`). */
export type VimTextObjectId = 'w' | 'W' | '"' | "'" | '`' | '(' | '[' | '{' | '<' | 'p' | 't'

/** Keys that open a multi-key command: `g…`, `z…`, `[…`, `]…`. See `PREFIX_TABLES` in vimKeymap.ts. */
export type VimPendingKind = 'g' | 'z' | '[' | ']'

/** Waiting for more keys. Only one is ever in flight. */
export type VimPending =
  | { readonly kind: VimPendingKind }
  /** `f`/`F`/`t`/`T` waiting for the character to look for. */
  | { readonly kind: 'find'; readonly motion: VimFindMotion }
  /** `r` waiting for the replacement character. */
  | { readonly kind: 'replace' }
  /** `"` waiting for the register name. */
  | { readonly kind: 'register' }
  /** `i` / `a` after an operator or in Visual mode, waiting for the object key. */
  | { readonly kind: 'textobject'; readonly around: boolean }

/** Visual-mode operations; `p` replaces the selection with a register. */
export type VimVisualAction =
  | 'delete'
  | 'yank'
  | 'change'
  | 'shift-right'
  | 'shift-left'
  | 'toggle-case'
  | 'lower'
  | 'upper'
  | 'join'
  | 'join-nospace'
  | 'replace'
  | 'paste'
  /** `P`: like `paste` but the replaced text does not overwrite the register. */
  | 'paste-keep'

/** Visual extent kept so `.` can replay a Visual operator over the same amount of text. */
export interface VimVisualExtent {
  readonly mode: VimVisualMode
  /** Lines spanned. */
  readonly lines: number
  /** Characters on the first line (single line) / last line (multi-line) / block width. */
  readonly columns: number
}

/** What the last repeatable buffer change was, replayable by `.`. */
export interface VimLastChange {
  readonly command: VimCommand
  readonly register: string | null
  /** Text typed during the Insert session the change opened, if any. */
  readonly insertedText: string | null
  /** Set for Visual operators: the command is replayed over a fresh selection of this size. */
  readonly visualExtent?: VimVisualExtent
}

export interface VimState {
  readonly mode: VimMode
  /**
   * Accumulated count; 0 means "none entered". While an operator is pending this
   * is the *motion* count (`d3w`); the count typed before the operator lives in
   * `operatorCount`.
   */
  readonly count: number
  /** Count typed before the pending operator (`2d3w` → 2); 0 when none. */
  readonly operatorCount: number
  readonly pendingOperator: VimOperator | null
  /** The multi-key prefix waiting for its next key; one at a time by construction. */
  readonly pending: VimPending | null
  /** Register selected with `"x` for the next command; null is the unnamed register. */
  readonly register: string | null
}

export const INITIAL_VIM_STATE: VimState = {
  mode: 'normal',
  count: 0,
  operatorCount: 0,
  pendingOperator: null,
  pending: null,
  register: null,
}

export type VimInsertPlacement =
  | 'before'
  | 'after'
  | 'line-start'
  | 'first-column'
  | 'line-end'
  | 'new-line-below'
  | 'new-line-above'

export type VimCommand =
  | {
      readonly type: 'motion'
      readonly motion: VimMotion
      readonly count: number
      /** The typed character of `f`/`F`/`t`/`T`. */
      readonly char?: string
    }
  | {
      readonly type: 'operator'
      readonly operator: VimOperator
      readonly motion: VimMotion
      readonly count: number
      readonly char?: string
    }
  /** `diw`, `ca(`: an operator over a text object. */
  | {
      readonly type: 'operator-textobject'
      readonly operator: VimOperator
      readonly object: VimTextObjectId
      readonly around: boolean
      readonly count: number
    }
  /** `dd`/`yy`/`>>`: `count` whole lines starting at the cursor. */
  | { readonly type: 'linewise'; readonly operator: VimOperator; readonly count: number }
  /** `count` repeats the typed text (`3ifoo<Esc>`); absent means once. */
  | {
      readonly type: 'enter-insert'
      readonly placement: VimInsertPlacement
      readonly count?: number
    }
  /** Insert-mode Escape: close the undo group and step the cursor back onto the last typed character. */
  | { readonly type: 'exit-insert' }
  | { readonly type: 'delete-char'; readonly count: number; readonly backward: boolean }
  | { readonly type: 'paste'; readonly count: number; readonly before: boolean }
  | { readonly type: 'undo' }
  | { readonly type: 'redo' }
  /** `J` joins with a single space; `gJ` (`keepSpacing`) joins verbatim. */
  | { readonly type: 'join-lines'; readonly count: number; readonly keepSpacing?: true }
  /** `r{char}`. */
  | { readonly type: 'replace-char'; readonly char: string; readonly count: number }
  /** `~`. */
  | { readonly type: 'toggle-case'; readonly count: number }
  /** `.`: replay the last change; a count replaces the original one. */
  | { readonly type: 'repeat-change'; readonly count: number }
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
  /**
   * Idle Normal-mode Escape: drop persistent `hlsearch` highlights
   * (`:nohlsearch`); with nothing to drop, hand focus to the editor tab strip.
   */
  | { readonly type: 'search-highlight-clear' }
  /** Monaco editor action (`gd`, `K`, `zc`, …); executed through `editor.trigger`. */
  | { readonly type: 'editor-command'; readonly commandId: string }
  /** Workbench command (`]c`, `[c`, `Ctrl+O`); executed through the injected command service. */
  | {
      readonly type: 'platform-command'
      readonly commandId: string
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
  /** `v` / `V` / `Ctrl+V`: start Visual mode, or switch between its kinds. */
  | { readonly type: 'visual-enter'; readonly mode: VimVisualMode }
  | { readonly type: 'visual-exit' }
  /** `o` (swap the cursor with the anchor) / `O` (block: swap the column only). */
  | { readonly type: 'visual-swap'; readonly corner: boolean }
  /** `gv`: reselect the previous Visual area. */
  | { readonly type: 'visual-reselect' }
  /** `d`/`y`/`c`/`>`/`~`/`J`/`r`/`p`… over the selection. */
  | {
      readonly type: 'visual-action'
      readonly action: VimVisualAction
      /** Force whole lines (`X`, `Y`, `S`). */
      readonly linewise?: true
      /** Block mode: extend every row to the end of its line (`D`, `C`). */
      readonly toEol?: true
      /** The replacement character of `r`. */
      readonly char?: string
      readonly count: number
    }
  | {
      readonly type: 'visual-textobject'
      readonly object: VimTextObjectId
      readonly around: boolean
      readonly count: number
    }
  /** Block `I` / `A`: insert at every row's left edge / right edge. */
  | { readonly type: 'visual-block-insert'; readonly at: 'start' | 'end' }

export interface VimKeyInput {
  readonly key: string
  readonly ctrl: boolean
  readonly alt: boolean
  readonly meta: boolean
  readonly shift: boolean
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
  /** The register `"x` selected for `command`; null when none (the state has already forgotten it). */
  readonly register: string | null
  /** Set when a printable key was swallowed because nothing claims it; holds the key label. */
  readonly unsupported?: string
}

export interface VimPosition {
  readonly line: number
  readonly column: number
}

/** Document order: negative when `a` is before `b`. */
export function comparePositions(a: VimPosition, b: VimPosition): number {
  return a.line !== b.line ? a.line - b.line : a.column - b.column
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

/**
 * Lazy, line-at-a-time view of a buffer. Motions only read the lines they walk
 * over, so a Normal-mode keystroke never materialises the whole file.
 */
export interface VimLineReader {
  getLineCount(): number
  getLineContent(lineNumber: number): string
}

/** The slice of `monaco.editor.ITextModel` the motions need. */
export interface VimTextModel extends VimLineReader {
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
  /** Block cursor in Normal/Visual; absent in fakes that do not model options. */
  updateOptions?(options: monaco.editor.IEditorOptions): void
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
