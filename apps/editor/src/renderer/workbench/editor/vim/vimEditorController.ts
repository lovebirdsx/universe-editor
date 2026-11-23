/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Binds the pure Vim core to one Monaco instance. The controller owns the
 *  Normal/Insert/Visual state, mirrors the mode onto the `vimMode` / `vimNormalMode`
 *  context keys, and dispatches each command to the module that implements it:
 *    vimEdits.ts       operators, paste, join, Visual actions, Insert entry/exit, undo grouping
 *    vimViewport.ts    folds, screen-row motions, zt/zz/zb, H/M/L, Ctrl+E/Y
 *    vimSearchController.ts  `/` `?` `n` `N` `*` `#` and hlsearch highlights
 *    vimInputMethod.ts window-wide IME ownership
 *  It never installs DOM listeners itself — the registry routes keystrokes here
 *  on window capture.
 *
 *  Beyond the per-keystroke dispatch it keeps what a single keystroke cannot:
 *  the Visual anchor/cursor pair (rendered into Monaco selections, never read back),
 *  the Insert session that `.` needs to replay, the block cursor, and the registers
 *  that live on the system clipboard.
 *
 *  New command: add its type to `VimCommand` (vimTypes.ts); `COMMAND_HANDLERS`
 *  is a `Record` over every type, so the compiler lists what is still missing.
 *--------------------------------------------------------------------------------------------*/

import {
  type IConfigurationService,
  type IContextKeyService,
  type IDisposable,
} from '@universe-editor/platform'
import { readClipboardText, writeClipboardText } from '@universe-editor/workbench-ui'
import type { monaco } from '../monaco/MonacoLoader.js'
import type { IVimModeService } from '../../../services/vim/vimModeService.js'
import type { IVimInputMethodService } from '../../../../shared/ipc/vimInputMethodService.js'
import { affectsBridgedEditorOption } from '../monaco/editorOptionsFromConfig.js'
import { createVimEdits, visualStartPosition } from './vimEdits.js'
import { releaseInputMethod, requestInputMethod } from './vimInputMethod.js'
import { consumeEvent, isImeKeyEvent, toVimKeyInput } from './vimKeyUtils.js'
import { formatPendingKeys, idle, isAwaitingCharArg, reduceVimKey } from './vimKeymap.js'
import { clampNormalPosition } from './vimMotions.js'
import { getVimRegister, isVimClipboardRegister, type VimRegisterContent } from './vimRegisters.js'
import { createVimSearchController } from './vimSearchController.js'
import {
  getLastVimChange,
  getLastVimFind,
  getLastVimInsertReplay,
  insertReplayText,
  isRepeatableChange,
  isWriteCommand,
  recordFind,
  setLastVimChange,
  withCount,
  type VimInsertOp,
  type VimInsertReplay,
} from './vimSession.js'
import { extendVisualByTextObject } from './vimTextObjects.js'
import {
  INITIAL_VIM_STATE,
  comparePositions,
  type VimCommand,
  type VimEditor,
  type VimLastChange,
  type VimMode,
  type VimMotionArgs,
  type VimPosition,
  type VimState,
} from './vimTypes.js'
import {
  selectionFromExtent,
  visualEolAfterMotion,
  visualExtent,
  visualMonacoSelections,
  type VimVisualSelection,
} from './vimVisual.js'
import { createVimViewport } from './vimViewport.js'

/** Normal-mode Escape with nothing to cancel hands focus to the editor tab strip. */
const FOCUS_EDITOR_TABS_COMMAND = 'workbench.action.focusEditorTabs'

const DEFAULT_CURSOR_STYLE = 'line'

type CursorStyle = NonNullable<monaco.editor.IEditorOptions['cursorStyle']>

export interface IVimEditorController extends IDisposable {
  readonly editor: VimEditor
  /** Vim is on globally and for the editor surface. */
  isEnabled(): boolean
  /** Whether this editor is the one currently holding Monaco's text focus. */
  hasTextFocus(): boolean
  /** Route one keydown; returns true when Vim consumed it. */
  handleKeyDown(event: KeyboardEvent): boolean
  /** The next key is consumed as the argument of `f`/`t`/`r`/`"`/`i`/`a` (a leader key must not steal it). */
  isAwaitingCharArg(): boolean
}

export interface VimClipboard {
  readText(): Promise<string>
  writeText(text: string): Promise<void>
}

export interface IVimEditorControllerOptions {
  readonly editor: VimEditor
  /**
   * Identifies this editor surface for per-surface mode memory. A function is
   * re-read when the Monaco model changes, so one editor instance reused across
   * tabs follows the active input's key without being rebuilt.
   */
  readonly surfaceKey: string | (() => string)
  readonly configService: IConfigurationService
  readonly contextKeyService: IContextKeyService
  readonly vimModeService: IVimModeService
  readonly inputMethodService: IVimInputMethodService
  /**
   * Executes workbench command ids that are not Monaco actions (`]c` / `[c`,
   * and the idle-Escape `workbench.action.focusEditorTabs`). Monaco actions go
   * through `editor.trigger` instead so the controller keeps working when the
   * commands registry is not ready yet.
   */
  readonly executeCommand?: (id: string, args?: unknown) => unknown
  /**
   * Monaco's configured line height. Only the sticky-scroll row math needs it;
   * call sites pass `editor.getOption(EditorOption.lineHeight)` and fakes may
   * omit it.
   */
  readonly getLineHeight?: () => number
  /** The system clipboard behind `"+` / `"*` and `vim.useSystemClipboard`; defaults to the host clipboard. */
  readonly clipboard?: VimClipboard
  /** The typed-so-far sequence (`2d`, `"a`, `g`) changed; `''` means nothing is pending. */
  readonly onPendingKeysChange?: (keys: string) => void
  /** A printable key was swallowed because Vim has no command for it. */
  readonly onUnsupportedKey?: (key: string) => void
  /** The Normal/Insert/Visual sub-mode of the focused editor changed. */
  readonly onSubModeChange?: (mode: VimMode) => void
  /** The buffer cannot be edited right now: write commands are refused and Insert is left. */
  readonly isReadOnly?: () => boolean
}

interface CommandContext {
  /** The `"x` register selected for this command. */
  readonly register: string | null
}

type CommandHandlers = {
  readonly [K in VimCommand['type']]: (
    command: Extract<VimCommand, { type: K }>,
    context: CommandContext,
  ) => void
}

/** What is needed to replay and finish the Insert session a command opened. */
interface InsertRecording {
  readonly start: VimPosition
  readonly command: VimCommand | null
  /** Set when the session's text should be stored for `.`. */
  readonly change: VimLastChange | null
  /** The keystrokes of the session, replayed through Monaco so auto-indent / auto-close fire again. */
  ops: VimInsertOp[]
  /** Something the key stream cannot reproduce happened (IME, Ctrl chord, paste): replay the net text. */
  opaque: boolean
  /** The caret was moved by arrow keys; Vim's `.` only repeats what was typed afterwards. */
  movedAway: boolean
}

/** The same cursor column that j / k keep, remembered together with where we left the cursor. */
interface DesiredColumn {
  readonly column: number
  readonly at: VimPosition
}

const END_OF_LINE_COLUMN = Number.MAX_SAFE_INTEGER
const MOVE_KEYS: ReadonlySet<string> = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])
const IGNORED_KEYS: ReadonlySet<string> = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'])

function toMonaco(position: VimPosition): { lineNumber: number; column: number } {
  return { lineNumber: position.line, column: position.column }
}

const defaultClipboard: VimClipboard = {
  readText: () => readClipboardText(),
  writeText: (text) => writeClipboardText(text),
}

export function createVimEditorController(
  options: IVimEditorControllerOptions,
): IVimEditorController {
  const {
    editor,
    surfaceKey,
    configService,
    contextKeyService,
    vimModeService,
    inputMethodService,
    executeCommand: runPlatformCommand,
    getLineHeight,
    clipboard = defaultClipboard,
    onPendingKeysChange,
    onUnsupportedKey,
    onSubModeChange,
    isReadOnly,
  } = options
  const resolveSurfaceKey = typeof surfaceKey === 'function' ? surfaceKey : () => surfaceKey
  // The key follows the model: until Monaco swaps models the controller is still
  // driving the old input, so writes must not land on the newly active key.
  let currentSurfaceKey = resolveSurfaceKey()
  // A surface returns in the mode it left (focus may sit in a list meanwhile).
  let state: VimState = { ...INITIAL_VIM_STATE, mode: readStoredMode() }
  let enabled = configService.get<boolean>('vim.enabled') === true
  let surfaceEnabled = configService.get<boolean>('vim.surfaces.editor') !== false
  let autoSwitchInputMethod = configService.get<boolean>('vim.autoSwitchInputMethod') !== false
  let useSystemClipboard = configService.get<boolean>('vim.useSystemClipboard') === true
  let textFocused = false
  const disposables: IDisposable[] = []

  // Visual selection: the controller owns it; Monaco only renders it.
  let visual: VimVisualSelection | null = null
  let lastVisual: VimVisualSelection | null = null
  let renderedSelectionKey: string | null = null

  // `.` bookkeeping.
  let replaying = false
  let currentChange: VimLastChange | null = null
  let currentCommand: VimCommand | null = null
  let commandFailed = false
  let insertRecording: InsertRecording | null = null

  let deferredChange = false
  let desiredColumn: DesiredColumn | null = null
  // Async clipboard paste: a result is applied only if nothing moved on meanwhile.
  let pasteGeneration = 0
  let contentVersion = 0

  let lastReportedPending = ''
  let cursorStyleApplied: 'block' | 'user' | null = null
  let disposed = false
  // Identity for the window-wide input-method ownership (see vimInputMethod.ts).
  const imeOwner = {}

  function readStoredMode(): VimMode {
    return vimModeService.getMode(currentSurfaceKey, 'normal') === 'insert' ? 'insert' : 'normal'
  }

  /** Vim is on for this editor: globally enabled and the editor surface not switched off. */
  function active(): boolean {
    return enabled && surfaceEnabled
  }

  /** Renderer keystrokes cannot suppress IME composition: Normal mode leaves the input method. */
  function syncInputMethod(): void {
    // A surface without text focus never asks for anything: it only gives back
    // the English it may still hold, so a background editor cannot fight the focused one.
    if (!textFocused) {
      releaseInputMethod(imeOwner, inputMethodService)
      return
    }
    const english = active() && autoSwitchInputMethod && state.mode !== 'insert'
    requestInputMethod(imeOwner, inputMethodService, english ? 'english' : 'native')
  }

  function userCursorStyle(): string {
    return configService.get<string>('editor.cursorStyle') ?? DEFAULT_CURSOR_STYLE
  }

  /** Block cursor in Normal/Visual; the user's own `editor.cursorStyle` comes back for Insert. */
  function syncCursorStyle(force = false): void {
    if (editor.updateOptions === undefined) return
    const target = active() && state.mode !== 'insert' ? 'block' : 'user'
    if (!force && cursorStyleApplied === target) return
    if (target === 'user' && cursorStyleApplied === null) return
    cursorStyleApplied = target
    editor.updateOptions({
      cursorStyle: (target === 'block' ? 'block' : userCursorStyle()) as CursorStyle,
    })
  }

  function syncContextKeys(): void {
    syncInputMethod()
    syncCursorStyle()
    // Blur keeps this surface's mode memory; while it does not hold text focus
    // the service's active-surface snapshot owns the root context keys.
    if (textFocused) {
      vimModeService.setMode(currentSurfaceKey, state.mode === 'insert' ? 'insert' : 'normal')
      onSubModeChange?.(state.mode)
    }
  }

  function reportPending(): void {
    const text = formatPendingKeys(state)
    if (text === lastReportedPending) return
    lastReportedPending = text
    onPendingKeysChange?.(text)
  }

  function editorPosition(): VimPosition {
    const selection = (editor.getSelections() ?? [])[0]
    if (selection === undefined) return { line: 1, column: 1 }
    return { line: selection.startLineNumber, column: selection.startColumn }
  }

  /** In Visual mode the cursor is the selection's moving end, not Monaco's caret. */
  function getCursor(): VimPosition {
    return visual !== null ? visual.cursor : editorPosition()
  }

  function selectionKey(): string {
    return JSON.stringify(editor.getSelections() ?? [])
  }

  function renderVisual(): void {
    const model = editor.getModel()
    if (model === null || visual === null) return
    editor.setSelections(visualMonacoSelections(model, visual), 'vim')
    renderedSelectionKey = selectionKey()
    editor.revealPositionInCenterIfOutsideViewport({
      lineNumber: visual.cursor.line,
      column: visual.cursor.column,
    })
  }

  function moveCursor(position: VimPosition): void {
    if (visual !== null) {
      const model = editor.getModel()
      visual = {
        ...visual,
        cursor: model === null ? position : clampNormalPosition(model, position),
      }
      renderVisual()
      return
    }
    const monacoPosition = { lineNumber: position.line, column: position.column }
    editor.setPosition(monacoPosition, 'vim')
    editor.revealPositionInCenterIfOutsideViewport(monacoPosition)
  }

  /** Something other than Vim moved the caret in Visual mode (H/M/L, a click): follow it. */
  function followEditorCursor(): void {
    if (visual === null || selectionKey() === renderedSelectionKey) return
    const model = editor.getModel()
    const at = editorPosition()
    visual = { ...visual, cursor: model === null ? at : clampNormalPosition(model, at) }
    renderVisual()
  }

  function leaveVisual(): void {
    if (visual === null) return
    lastVisual = visual
    const cursor = visual.cursor
    visual = null
    renderedSelectionKey = null
    moveCursor(cursor)
  }

  function setMode(mode: VimMode): void {
    if (mode === 'insert' && state.mode !== 'insert') {
      insertRecording = {
        start: getCursor(),
        command: currentCommand,
        change: currentChange,
        ops: [],
        opaque: false,
        movedAway: false,
      }
    }
    state = { ...state, mode }
    syncContextKeys()
  }

  // ── registers ──────────────────────────────────────────────────────────────

  function reportClipboardFailure(action: string, error: unknown): void {
    console.debug(`[vim] system clipboard ${action} failed`, error)
  }

  function writeToClipboard(content: VimRegisterContent, register: string | null): void {
    if (!isVimClipboardRegister(register) && !(register === null && useSystemClipboard)) return
    void clipboard.writeText(content.text).catch((error: unknown) => {
      reportClipboardFailure('write', error)
    })
  }

  function contentFromClipboard(text: string): VimRegisterContent | null {
    const normalized = text.replace(/\r\n?/g, '\n')
    if (normalized === '') return null
    // Text we wrote ourselves keeps its shape (linewise / blockwise) across the round trip.
    const own = getVimRegister(null)
    if (own !== null && own.text === normalized) return own
    return { text: normalized, linewise: normalized.endsWith('\n') }
  }

  /** What `p` should put: synchronous for ordinary registers, a promise when the clipboard is involved. */
  function resolvePasteContent(
    register: string | null,
  ): VimRegisterContent | null | Promise<VimRegisterContent | null> {
    if (!isVimClipboardRegister(register) && !(register === null && useSystemClipboard)) {
      return getVimRegister(register)
    }
    return clipboard.readText().then(contentFromClipboard, (error: unknown) => {
      reportClipboardFailure('read', error)
      return register === null ? getVimRegister(null) : null
    })
  }

  /**
   * Put register content. A synchronous register applies at once; the system
   * clipboard answers later, so its result is dropped when the editor moved on
   * (another key, an edit, a model swap, disposal) and `.` is only recorded once the
   * paste really happened.
   */
  function withPasteContent(
    register: string | null,
    apply: (content: VimRegisterContent | null) => boolean,
    change: VimLastChange | null,
  ): void {
    const content = resolvePasteContent(register)
    if (!(content instanceof Promise)) {
      if (!apply(content)) commandFailed = true
      return
    }
    deferredChange = true
    const generation = ++pasteGeneration
    const version = contentVersion
    const at = selectionKey()
    void content.then((resolved) => {
      if (
        disposed ||
        generation !== pasteGeneration ||
        version !== contentVersion ||
        at !== selectionKey()
      ) {
        console.debug('[vim] dropped a stale clipboard paste')
        return
      }
      if (apply(resolved) && change !== null) setLastVimChange(change)
      followEditorCursor()
    })
  }

  // ── collaborators ──────────────────────────────────────────────────────────

  const viewport = createVimViewport({ editor, getLineHeight, getCursor })
  const edits = createVimEdits({
    editor,
    getCursor,
    moveCursor,
    setMode,
    onRegisterWrite: writeToClipboard,
    closedFoldAt: viewport.closedFoldAt,
    createScreenOps: viewport.createScreenOps,
  })
  const search = createVimSearchController({
    editor,
    configService,
    contextKeyService,
    isEnabled: active,
    getCursor,
    moveCursor,
  })

  // ── `.` repeat ─────────────────────────────────────────────────────────────

  function motionArgs(char: string | undefined): VimMotionArgs {
    return { ...(char === undefined ? {} : { char }), lastFind: getLastVimFind() }
  }

  /** The text typed since the Insert session opened, `\n`-normalized. */
  function typedSince(start: VimPosition): string {
    const model = editor.getModel()
    const end = editorPosition()
    if (model === null || comparePositions(end, start) <= 0) return ''
    return model
      .getValueInRange({
        startLineNumber: start.line,
        startColumn: start.column,
        endLineNumber: end.line,
        endColumn: end.column,
      })
      .replace(/\r\n?/g, '\n')
  }

  /** `3ifoo<Esc>` types foo three times; `3o` opens three lines. */
  function repeatInsertedText(command: VimCommand | null, text: string): void {
    if (command?.type !== 'enter-insert' || text === '') return
    const extra = (command.count ?? 1) - 1
    if (extra <= 0) return
    const opensLine =
      command.placement === 'new-line-below' || command.placement === 'new-line-above'
    edits.typeText(`${opensLine ? '\n' : ''}${text}`.repeat(extra))
  }

  function finishInsertSession(): void {
    const recording = insertRecording
    insertRecording = null
    if (recording !== null) {
      const { literal, replay } = summarizeInsert(recording)
      repeatInsertedText(recording.command, literal)
      if (recording.change !== null && !replaying) {
        setLastVimChange({ ...recording.change, insertedText: literal }, replay)
      }
    }
    edits.exitInsert()
  }

  /** The net typed text and what `.` replays for it: the key stream when it can be trusted. */
  function summarizeInsert(recording: InsertRecording): {
    literal: string
    replay: VimInsertReplay | null
  } {
    const keyed: VimInsertReplay = { keys: recording.ops }
    const literal = recording.movedAway ? insertReplayText(keyed) : typedSince(recording.start)
    if (recording.ops.length === 0 || recording.opaque) {
      return { literal, replay: literal === '' ? null : { literal } }
    }
    return { literal, replay: keyed }
  }

  /** Remember the keystroke of an Insert session that Monaco is about to handle itself. */
  function recordInsertKey(event: KeyboardEvent): void {
    const recording = insertRecording
    if (recording === null || replaying) return
    if (IGNORED_KEYS.has(event.key)) return
    if (MOVE_KEYS.has(event.key)) {
      recording.ops = []
      recording.movedAway = true
      return
    }
    if (event.ctrlKey || event.metaKey || event.altKey) {
      recording.opaque = true
      return
    }
    const op = insertOpFor(event)
    if (op === null) {
      recording.opaque = true
      return
    }
    const previous = recording.ops[recording.ops.length - 1]
    // A line break stays its own op: Monaco auto-indents per typed character.
    if (
      op.kind === 'type' &&
      previous?.kind === 'type' &&
      op.text !== '\n' &&
      previous.text !== '\n'
    ) {
      recording.ops[recording.ops.length - 1] = { kind: 'type', text: previous.text + op.text }
    } else {
      recording.ops.push(op)
    }
  }

  function insertOpFor(event: KeyboardEvent): VimInsertOp | null {
    switch (event.key) {
      case 'Enter':
        return { kind: 'type', text: '\n' }
      case 'Backspace':
        return { kind: 'delete-left' }
      case 'Delete':
        return { kind: 'delete-right' }
      case 'Tab':
        return event.shiftKey ? null : { kind: 'tab' }
      default:
        return Array.from(event.key).length === 1 ? { kind: 'type', text: event.key } : null
    }
  }

  function repeatChange(count: number): void {
    const last = getLastVimChange()
    if (last === null || replaying) return
    const lastReplay = getLastVimInsertReplay()
    const command = count > 0 ? withCount(last.command, count) : last.command
    replaying = true
    try {
      if (last.visualExtent !== undefined) {
        const model = editor.getModel()
        if (model === null) return
        const from = clampNormalPosition(model, getCursor())
        visual = selectionFromExtent(model, from, last.visualExtent)
      }
      runCommand(command, last.register)
      if (state.mode === 'insert') {
        const text = last.insertedText ?? ''
        if (lastReplay !== null) edits.replayInsert(lastReplay)
        repeatInsertedText(command, text)
        insertRecording = null
        edits.exitInsert()
        setMode('normal')
      }
    } finally {
      replaying = false
      insertRecording = null
    }
    // `3.` makes the next `.` repeat three, like Vim.
    if (count > 0) setLastVimChange({ ...last, command }, lastReplay)
  }

  // ── commands ───────────────────────────────────────────────────────────────

  /** Handlers fetch the model themselves so a model-less editor is a no-op, not a crash. */
  const COMMAND_HANDLERS: CommandHandlers = {
    motion(command) {
      const model = editor.getModel()
      if (model === null) return
      recordFind(command.motion, command.char)
      const cursor = getCursor()
      const vertical = command.motion === 'j' || command.motion === 'k'
      // j / k aim for the column the cursor had before a short line clamped it.
      const want = vertical ? (currentDesiredColumn(cursor) ?? cursor.column) : null
      const target = viewport.resolveScreenMotion(
        model,
        want === null ? cursor : { line: cursor.line, column: want },
        command.motion,
        command.count,
        motionArgs(command.char),
      )
      if (target === null) return
      moveCursor(target)
      if (visual !== null) {
        const eol = visualEolAfterMotion(visual.eol === true, command.motion)
        if (eol !== (visual.eol === true)) {
          visual = { ...visual, eol }
          renderVisual()
        }
      }
      if (vertical && want !== null) {
        desiredColumn = { column: want, at: getCursor() }
      } else if (command.motion === '$') {
        desiredColumn = { column: END_OF_LINE_COLUMN, at: getCursor() }
      }
    },
    operator(command, { register }) {
      recordFind(command.motion, command.char)
      const done = edits.runOperator(
        command.operator,
        command.motion,
        command.count,
        register,
        motionArgs(command.char),
      )
      if (!done) commandFailed = true
    },
    'operator-textobject'(command, { register }) {
      const done = edits.runOperatorTextObject(
        command.operator,
        command.object,
        command.around,
        command.count,
        register,
      )
      if (!done) commandFailed = true
    },
    linewise(command, { register }) {
      if (!edits.runLinewise(command.operator, command.count, register)) commandFailed = true
    },
    'enter-insert': (command) => edits.enterInsert(command.placement),
    'exit-insert': () => finishInsertSession(),
    'delete-char'(command, { register }) {
      if (!edits.deleteChars(command.count, command.backward, register)) commandFailed = true
    },
    'substitute-char'(command, { register }) {
      if (!edits.substituteChar(command.count, register)) commandFailed = true
    },
    paste: (command, { register }) =>
      withPasteContent(
        register,
        (content) => edits.paste(content, command.count, command.before),
        currentChange,
      ),
    undo: () => edits.undo(),
    redo: () => edits.redo(),
    'join-lines'(command) {
      if (!edits.joinLines(command.count, command.keepSpacing === true)) commandFailed = true
    },
    'replace-char'(command) {
      if (!edits.replaceChar(command.char, command.count)) commandFailed = true
    },
    'toggle-case'(command) {
      if (!edits.toggleCase(command.count)) commandFailed = true
    },
    'repeat-change': (command) => repeatChange(command.count),
    'search-open': (command) => search.open(command.direction, command.count),
    'search-repeat': (command) => search.repeat(command.reverse, command.count),
    'search-word': (command) => search.searchWord(command.direction, command.count),
    'search-highlight-clear'() {
      if (search.clearHighlights()) return
      console.debug('[vim] Escape with nothing to clear; focusing the editor tab strip')
      void runPlatformCommand?.(FOCUS_EDITOR_TABS_COMMAND)
    },
    'editor-command': (command) => editor.trigger('vim', command.commandId, null),
    'platform-command'(command) {
      const steps = Math.max(1, command.count)
      for (let index = 0; index < steps; index++) void runPlatformCommand?.(command.commandId)
    },
    'scroll-viewport': (command) => viewport.scrollViewport(command),
    'reveal-line'(command) {
      const model = editor.getModel()
      if (model !== null) viewport.revealLine(command, model)
    },
    'goto-viewport-line'(command) {
      const model = editor.getModel()
      if (model !== null) viewport.gotoViewportLine(command, model)
    },
    'fold-goto'(command) {
      const model = editor.getModel()
      if (model !== null) viewport.foldGoto(command, model)
    },
    'visual-enter'(command) {
      if (visual !== null) {
        visual = { ...visual, mode: command.mode }
      } else {
        const model = editor.getModel()
        const at = model === null ? editorPosition() : clampNormalPosition(model, editorPosition())
        visual = { mode: command.mode, anchor: at, cursor: at }
      }
      renderVisual()
    },
    'visual-exit': () => leaveVisual(),
    'visual-swap'(command) {
      if (visual === null) return
      const { anchor, cursor } = visual
      visual =
        !command.corner && visual.mode === 'visual-block'
          ? {
              ...visual,
              anchor: { line: anchor.line, column: cursor.column },
              cursor: { line: cursor.line, column: anchor.column },
            }
          : { ...visual, anchor: cursor, cursor: anchor }
      renderVisual()
    },
    'visual-reselect'() {
      const previous = lastVisual
      const model = editor.getModel()
      if (previous === null || model === null) return
      if (visual !== null) lastVisual = visual
      // The buffer may have shrunk since the selection was remembered.
      visual = {
        ...previous,
        anchor: clampNormalPosition(model, previous.anchor),
        cursor: clampNormalPosition(model, previous.cursor),
      }
      setMode(previous.mode)
      renderVisual()
    },
    'visual-action'(command, { register }) {
      const selection = visual
      const model = editor.getModel()
      if (selection === null || model === null) return
      lastVisual = selection
      visual = null
      renderedSelectionKey = null
      // Monaco keeps the Visual range selected until something replaces it. Collapse
      // it first so an async paste, an empty register or a failed action cannot leave
      // it behind, and undo records a caret instead of the whole range.
      editor.setPosition(
        toMonaco(clampNormalPosition(model, visualStartPosition(selection))),
        'vim',
      )
      const run = (content: VimRegisterContent | null | undefined): boolean =>
        edits.visualAction(selection, command.action, {
          linewise: command.linewise,
          toEol: command.toEol,
          char: command.char,
          count: command.count,
          register,
          content,
        })
      if (command.action === 'paste' || command.action === 'paste-keep') {
        withPasteContent(register, run, currentChange)
      } else if (!run(undefined)) {
        commandFailed = true
      }
    },
    'visual-textobject'(command) {
      const model = editor.getModel()
      if (visual === null || model === null) return
      const next = extendVisualByTextObject({
        lines: model,
        selection: visual,
        object: command.object,
        around: command.around,
        count: command.count,
      })
      if (next === null) return
      visual = next
      setMode(next.mode)
      renderVisual()
    },
    'visual-block-insert'(command) {
      const selection = visual
      if (selection === null) return
      lastVisual = selection
      visual = null
      renderedSelectionKey = null
      edits.visualBlockInsert(selection, command.at)
    },
  }

  /** The change `.` would replay for this command, or null when it is not repeatable. */
  function changeFor(command: VimCommand, register: string | null): VimLastChange | null {
    if (replaying || !isRepeatableChange(command)) return null
    if (command.type !== 'visual-action') {
      return { command, register, insertedText: null }
    }
    if (visual === null) return null
    // Block `c` leaves one cursor per row, which `.` cannot type into.
    if (command.action === 'change' && visual.mode === 'visual-block') return null
    return { command, register, insertedText: null, visualExtent: visualExtent(visual) }
  }

  function readOnly(): boolean {
    return isReadOnly?.() === true
  }

  /** The reducer already moved to Insert / left Visual for a command a read-only buffer refuses. */
  function refuseWrite(command: VimCommand): void {
    console.debug(`[vim] "${command.type}" refused: the buffer is read-only`)
    if (state.mode === 'insert') state = { ...state, mode: 'normal' }
    insertRecording = null
    if (visual !== null) leaveVisual()
    if (state.mode !== 'normal') state = { ...state, mode: 'normal' }
  }

  function currentDesiredColumn(cursor: VimPosition): number | null {
    const remembered = desiredColumn
    return remembered !== null && comparePositions(remembered.at, cursor) === 0
      ? remembered.column
      : null
  }

  function runCommand(command: VimCommand, register: string | null): void {
    if (isWriteCommand(command) && readOnly()) {
      refuseWrite(command)
      return
    }
    const change = changeFor(command, register)
    currentCommand = command
    currentChange = change
    commandFailed = false
    deferredChange = false
    try {
      // The union is correlated with its handler by `type`; TS cannot see that.
      const handler = COMMAND_HANDLERS[command.type] as (
        command: VimCommand,
        context: CommandContext,
      ) => void
      handler(command, { register })
    } finally {
      currentCommand = null
      currentChange = null
    }
    // A change that opened an Insert session is stored when the session ends.
    const openedInsert = insertRecording !== null && insertRecording.change === change
    if (change !== null && !commandFailed && !openedInsert && !deferredChange) {
      setLastVimChange(change)
    }
    followEditorCursor()
  }

  function resetTransient(): void {
    visual = null
    lastVisual = null
    renderedSelectionKey = null
    insertRecording = null
    desiredColumn = null
    pasteGeneration++
  }

  /** A mouse click or an external selection change ends Visual mode, like Vim. */
  function dropStaleVisual(): void {
    if (visual === null || selectionKey() === renderedSelectionKey) return
    const at = editorPosition()
    // `gv` still finds what the user had selected, as after `<Esc>`.
    lastVisual = visual
    visual = null
    renderedSelectionKey = null
    state = { ...idle(state), mode: 'normal' }
    editor.setPosition({ lineNumber: at.line, column: at.column }, 'vim')
    syncContextKeys()
    reportPending()
  }

  function handleKeyDown(event: KeyboardEvent): boolean {
    if (!active() || !textFocused) return false
    if (isImeKeyEvent(event)) {
      // Composition bypasses the key stream; `.` falls back to the net text.
      if (insertRecording !== null) insertRecording.opaque = true
      return false
    }
    if (state.mode === 'insert' && readOnly()) {
      insertRecording = null
      state = { ...state, mode: 'normal' }
      syncContextKeys()
    }
    dropStaleVisual()
    const result = reduceVimKey(state, toVimKeyInput(event))
    // An unhandled key still resets a half-typed prefix (`d` then Ctrl+Z).
    state = result.state
    if (!result.handled) {
      if (state.mode === 'insert') recordInsertKey(event)
      reportPending()
      return false
    }
    consumeEvent(event)
    if (result.unsupported !== undefined) onUnsupportedKey?.(result.unsupported)
    if (result.command !== null) runCommand(result.command, result.register)
    syncContextKeys()
    reportPending()
    return true
  }

  /** Back to a pristine Normal state: nothing in flight, no selection, no search UI. */
  function deactivate(): void {
    state = INITIAL_VIM_STATE
    if (visual !== null) {
      const at = visual.cursor
      visual = null
      editor.setPosition({ lineNumber: at.line, column: at.column }, 'vim')
    }
    resetTransient()
    search.onDisabled()
    reportPending()
  }

  disposables.push(
    editor.onDidFocusEditorText(() => {
      textFocused = true
      syncContextKeys()
    }),
    editor.onDidBlurEditorText(() => {
      textFocused = false
      // Keep the mode so returning focus resumes it; only the in-flight prefix
      // belongs to the focus that was lost.
      state = idle(state)
      syncContextKeys()
      reportPending()
    }),
    editor.onDidChangeModel(() => {
      currentSurfaceKey = resolveSurfaceKey()
      state = { ...INITIAL_VIM_STATE, mode: readStoredMode() }
      resetTransient()
      search.onModelChange()
      syncContextKeys()
      reportPending()
    }),
    editor.onDidChangeModelContent(() => {
      contentVersion++
      search.onContentChange()
    }),
    configService.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('vim.useSystemClipboard')) {
        useSystemClipboard = configService.get<boolean>('vim.useSystemClipboard') === true
      }
      let reevaluate = false
      if (event.affectsConfiguration('vim.surfaces.editor')) {
        const next = configService.get<boolean>('vim.surfaces.editor') !== false
        if (next !== surfaceEnabled) {
          surfaceEnabled = next
          if (!surfaceEnabled) deactivate()
          reevaluate = true
        }
      }
      if (event.affectsConfiguration('vim.enabled')) {
        const next = configService.get<boolean>('vim.enabled') === true
        if (next !== enabled) {
          enabled = next
          if (!enabled) deactivate()
          reevaluate = true
        }
      }
      if (event.affectsConfiguration('vim.autoSwitchInputMethod')) {
        autoSwitchInputMethod = configService.get<boolean>('vim.autoSwitchInputMethod') !== false
        reevaluate = true
      }
      if (reevaluate) syncContextKeys()
      // The editor option bridge re-applies `editor.cursorStyle` with any bridged
      // option; take the block cursor back once it has finished.
      if (
        cursorStyleApplied === 'block' &&
        (event.affectsConfiguration('editor.cursorStyle') || affectsBridgedEditorOption(event))
      ) {
        queueMicrotask(() => {
          if (!disposed) syncCursorStyle(true)
        })
      }
      search.onConfigChange(event)
    }),
  )

  syncContextKeys()

  return {
    editor,
    isEnabled: active,
    hasTextFocus: () => textFocused,
    handleKeyDown,
    isAwaitingCharArg: () => active() && textFocused && isAwaitingCharArg(state),
    dispose: () => {
      if (disposed) return
      disposed = true
      pasteGeneration++
      for (const disposable of disposables) disposable.dispose()
      disposables.length = 0
      search.dispose()
      if (cursorStyleApplied === 'block') {
        // The editor may already be disposed (DiffEditor tears the pair down first).
        try {
          editor.updateOptions?.({ cursorStyle: userCursorStyle() as CursorStyle })
        } catch (error) {
          console.debug('[vim] could not restore the cursor style on dispose', error)
        }
      }
      if (lastReportedPending !== '') onPendingKeysChange?.('')
      // Only the owner that switched to English may switch back: main's saved input
      // method is shared, so a background group's disposal must not yank Chinese
      // back under the focused group.
      releaseInputMethod(imeOwner, inputMethodService)
    },
  }
}
