/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Binds the pure Vim core to one Monaco instance. The controller owns the
 *  Normal/Insert state, executes commands through Monaco's public editor API,
 *  and mirrors the mode onto the `vimMode` / `vimNormalMode` context keys plus
 *  the status-bar entry. It never installs DOM listeners itself — the registry
 *  routes keystrokes here on window capture.
 *--------------------------------------------------------------------------------------------*/

import {
  StatusBarAlignment,
  localize,
  type IConfigurationService,
  type IContextKeyService,
  type IDisposable,
  type IStatusBarEntry,
  type IStatusBarEntryAccessor,
  type IStatusBarService,
} from '@universe-editor/platform'
import type { IVimInputMethodService } from '../../../../shared/ipc/vimInputMethodService.js'
import { reduceVimKey } from './vimKeymap.js'
import { clampNormalPosition, firstNonBlankColumn, resolveMotion } from './vimMotions.js'
import { linewiseRange, resolveOperatorRange } from './vimOperators.js'
import { getVimRegister, setVimRegister } from './vimRegisters.js'
import {
  INITIAL_VIM_STATE,
  type VimCommand,
  type VimEditor,
  type VimMotion,
  type VimPosition,
  type VimRange,
  type VimState,
  type VimTextModel,
} from './vimTypes.js'

const VIM_STATUS_ENTRY_ID = 'vim-mode'
const VIM_STATUS_PRIORITY = 5000

/**
 * Shared by every controller in this window. Main keeps one saved input method
 * per window (`VimInputMethodMainService.saved`), so ownership has to be
 * tracked at the same granularity — a per-controller copy would let a newly
 * mounted editor group restore Chinese under the focused group's feet.
 */
let inputMethodState: 'english' | 'native' | null = null
let inputMethodChain: Promise<void> = Promise.resolve()

export interface IVimEditorController extends IDisposable {
  readonly editor: VimEditor
  isEnabled(): boolean
  /** Whether this editor is the one currently holding Monaco's text focus. */
  hasTextFocus(): boolean
  /** Route one keydown; returns true when Vim consumed it. */
  handleKeyDown(event: KeyboardEvent): boolean
}

export interface IVimEditorControllerOptions {
  readonly editor: VimEditor
  readonly configService: IConfigurationService
  readonly contextKeyService: IContextKeyService
  readonly statusBarService: IStatusBarService
  readonly inputMethodService: IVimInputMethodService
}

function readLines(model: VimTextModel): string[] {
  const count = model.getLineCount()
  const lines: string[] = []
  for (let line = 1; line <= count; line++) lines.push(model.getLineContent(line))
  return lines
}

function toMonacoPosition(position: VimPosition): { lineNumber: number; column: number } {
  return { lineNumber: position.line, column: position.column }
}

export function createVimEditorController(
  options: IVimEditorControllerOptions,
): IVimEditorController {
  const { editor, configService, contextKeyService, statusBarService, inputMethodService } = options
  let state: VimState = INITIAL_VIM_STATE
  let enabled = configService.get<boolean>('editor.vimMode.enabled') === true
  let autoSwitchInputMethod =
    configService.get<boolean>('editor.vimMode.autoSwitchInputMethod') !== false
  let textFocused = false
  let statusEntry: IStatusBarEntryAccessor | undefined

  const disposables: IDisposable[] = []

  function showStatusBar(): boolean {
    return (
      enabled && textFocused && configService.get<boolean>('editor.vimMode.showStatusBar') !== false
    )
  }

  function statusEntryData(): IStatusBarEntry {
    return {
      id: VIM_STATUS_ENTRY_ID,
      // Icon-only: the glyph carries the mode, the tooltip names it. The old
      // `-- NORMAL --` text was too loud for a persistent status-bar slot.
      text: '',
      icon: state.mode === 'insert' ? 'vim-insert' : 'vim-normal',
      tooltip:
        state.mode === 'insert'
          ? localize('vim.status.insert', 'Vim: Insert (click to toggle)')
          : localize('vim.status.normal', 'Vim: Normal (click to toggle)'),
      alignment: StatusBarAlignment.Right,
      priority: VIM_STATUS_PRIORITY,
      command: 'workbench.action.toggleVimMode',
    }
  }

  function disposeStatusEntry(): void {
    statusEntry?.dispose()
    statusEntry = undefined
  }

  function syncStatusBar(): void {
    if (!showStatusBar()) {
      disposeStatusEntry()
      return
    }
    const entry = statusEntryData()
    if (statusEntry === undefined) {
      statusEntry = statusBarService.addEntry(entry)
      return
    }
    statusEntry.update(entry)
  }

  /**
   * Renderer keystrokes cannot suppress IME composition, so Normal mode leaves
   * the input method instead: main switches the focused window to English there
   * and Insert mode restores it. Only mode *transitions* reach main — this runs
   * on every keystroke via `syncContextKeys`, and the guard collapses those.
   */
  function syncInputMethod(): void {
    const desired: 'english' | 'native' =
      enabled && autoSwitchInputMethod && textFocused && state.mode === 'normal'
        ? 'english'
        : 'native'
    if (desired === inputMethodState) return
    inputMethodState = desired
    // Serialize: a fast Esc → i pair must not reorder the two IPC calls.
    inputMethodChain = inputMethodChain
      .then(async () => {
        if (desired === 'native') {
          await inputMethodService.restore()
          return
        }
        // `switchToEnglish` reports whether English is active, not whether it
        // switched, so an already-English IME stays deduped; a refusal (null
        // HWND, no IME context) falls back to `native` and retries next stroke.
        if (!(await inputMethodService.switchToEnglish()) && inputMethodState === 'english') {
          inputMethodState = 'native'
        }
      })
      .catch(() => {
        inputMethodState = 'native'
      })
  }

  function syncContextKeys(): void {
    syncInputMethod()
    // Report a mode only while this editor owns text focus; an unfocused
    // controller's `normal` would otherwise claim the key with nothing behind it.
    if (!enabled || !textFocused) {
      contextKeyService.set('vimMode', '')
      contextKeyService.set('vimNormalMode', false)
      return
    }
    contextKeyService.set('vimMode', state.mode)
    contextKeyService.set('vimNormalMode', state.mode === 'normal')
  }

  function setMode(mode: VimState['mode']): void {
    state = { ...state, mode }
    syncContextKeys()
    syncStatusBar()
  }

  function setPosition(position: VimPosition): void {
    editor.setPosition(toMonacoPosition(position), 'vim')
    editor.revealPositionInCenterIfOutsideViewport(toMonacoPosition(position))
  }

  function applyDelete(range: VimRange): void {
    if (range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn) {
      return
    }
    editor.pushUndoStop()
    editor.executeEdits('vim', [{ range, text: '' }])
    editor.pushUndoStop()
    const model = editor.getModel()
    const lines = model ? readLines(model) : []
    const target = clampNormalPosition(lines, {
      line: range.startLineNumber,
      column: range.startColumn,
    })
    editor.setPosition(toMonacoPosition(target), 'vim')
  }

  function visibleRowCount(): number {
    const ranges = editor.getVisibleRanges()
    if (ranges.length === 0) return 20
    let count = 0
    for (const range of ranges) count += range.endLineNumber - range.startLineNumber + 1
    return Math.max(1, count)
  }

  function resolveVisualMotion(
    lines: readonly string[],
    from: VimPosition,
    motion: VimMotion,
    count: number,
  ): VimPosition | null {
    const visible = visibleRowCount()
    switch (motion) {
      case 'pageDown':
        return resolveMotion(lines, from, 'j', visible)
      case 'pageUp':
        return resolveMotion(lines, from, 'k', visible)
      case 'halfPageDown':
        return resolveMotion(lines, from, 'j', Math.max(1, Math.floor(visible / 2)))
      case 'halfPageUp':
        return resolveMotion(lines, from, 'k', Math.max(1, Math.floor(visible / 2)))
      default:
        return resolveMotion(lines, from, motion, count)
    }
  }

  /**
   * Motions that need only the cursor line and the line count. Resolving them
   * without materialising the whole buffer keeps every Normal-mode keystroke
   * O(1) on large files; `undefined` means the motion needs the full text.
   */
  function resolveSimpleMotion(
    model: VimTextModel,
    from: VimPosition,
    motion: VimMotion,
    count: number,
  ): VimPosition | null | undefined {
    const steps = Math.max(1, count)
    const clampColumn = (line: number, column: number): VimPosition => {
      const len = model.getLineContent(line).length
      return { line, column: len === 0 ? 1 : Math.max(1, Math.min(len, column)) }
    }
    switch (motion) {
      case 'h':
        return clampColumn(from.line, from.column - steps)
      case 'l':
        return clampColumn(from.line, from.column + steps)
      case '0':
        return { line: from.line, column: 1 }
      case '$':
        return { line: from.line, column: Math.max(1, model.getLineContent(from.line).length) }
      case '^':
        return { line: from.line, column: firstNonBlankColumn(model.getLineContent(from.line)) }
      case 'j':
        return clampColumn(Math.min(model.getLineCount(), from.line + steps), from.column)
      case 'k':
        return clampColumn(Math.max(1, from.line - steps), from.column)
      default:
        return undefined
    }
  }

  function executeCommand(command: VimCommand): void {
    const model = editor.getModel()
    if (!model) return
    const from = primaryPosition()

    if (command.type === 'motion') {
      const target = resolveSimpleMotion(model, from, command.motion, command.count)
      if (target !== undefined) {
        if (target !== null) setPosition(target)
        return
      }
    }

    const lines = readLines(model)

    switch (command.type) {
      case 'motion': {
        const target = resolveVisualMotion(lines, from, command.motion, command.count)
        if (target !== null) setPosition(target)
        return
      }
      case 'operator': {
        const opRange = resolveOperatorRange(lines, from, command.motion, command.count)
        if (opRange === null) return
        // Vim's delete operator also yanks into the unnamed register, so
        // `dd` followed by `p` is the everyday move-line idiom.
        setVimRegister({
          text: model.getValueInRange(opRange.range),
          linewise: opRange.linewise,
        })
        if (command.operator === 'y') return
        applyDelete(opRange.range)
        return
      }
      case 'linewise': {
        const startLine = Math.min(from.line, lines.length)
        const endLine = Math.min(lines.length, startLine + Math.max(1, command.count) - 1)
        setVimRegister({
          text: `${lines.slice(startLine - 1, endLine).join('\n')}\n`,
          linewise: true,
        })
        if (command.operator === 'y') return
        applyDelete(linewiseRange(lines, startLine, endLine))
        return
      }
      case 'enter-insert': {
        enterInsert(command)
        return
      }
      case 'delete-char': {
        deleteChars(command.count, command.backward)
        return
      }
      case 'paste': {
        paste(command.count, command.before)
        return
      }
      case 'undo': {
        editor.trigger('vim', 'undo', null)
        return
      }
      case 'join-lines': {
        // `J` joins two lines and every extra count one more, so the number of
        // joins is `count - 1` (a bare `J` still joins once).
        const joins = Math.max(1, command.count - 1)
        for (let i = 0; i < joins; i++) {
          editor.trigger('vim', 'editor.action.joinLines', null)
        }
        return
      }
    }
  }

  function enterInsert(command: Extract<VimCommand, { type: 'enter-insert' }>): void {
    if (!editor.getModel()) return
    const from = primaryPosition()
    switch (command.placement) {
      case 'before':
        setPosition(from)
        break
      case 'line-start':
        setPosition({ line: from.line, column: 1 })
        break
    }
    setMode('insert')
  }

  function deleteChars(count: number, backward: boolean): void {
    const model = editor.getModel()
    if (!model) return
    const from = primaryPosition()
    const lineLength = model.getLineContent(from.line).length
    const startColumn = backward ? Math.max(1, from.column - Math.max(1, count)) : from.column
    const endColumn = backward ? from.column : Math.min(lineLength + 1, from.column + count)
    if (startColumn === endColumn) return
    const range = {
      startLineNumber: from.line,
      startColumn,
      endLineNumber: from.line,
      endColumn,
    }
    setVimRegister({ text: model.getValueInRange(range), linewise: false })
    editor.pushUndoStop()
    editor.executeEdits('vim', [{ range, text: '' }])
    editor.pushUndoStop()
    editor.setPosition(toMonacoPosition({ line: from.line, column: startColumn }), 'vim')
  }

  function paste(count: number, before: boolean): void {
    const register = getVimRegister()
    if (register === null) return
    const model = editor.getModel()
    if (!model) return
    const from = primaryPosition()
    const lineCount = model.getLineCount()
    const repeated = Array.from({ length: Math.max(1, count) }, () => register.text).join('')

    if (register.linewise) {
      const insertLine = before ? from.line : from.line + 1
      const text = repeated.endsWith('\n') ? repeated : `${repeated}\n`
      editor.pushUndoStop()
      if (insertLine > lineCount) {
        const lastLength = model.getLineContent(lineCount).length
        editor.executeEdits('vim', [
          {
            range: {
              startLineNumber: lineCount,
              startColumn: lastLength + 1,
              endLineNumber: lineCount,
              endColumn: lastLength + 1,
            },
            text: `\n${text.slice(0, -1)}`,
          },
        ])
        editor.pushUndoStop()
        setPosition({ line: lineCount + 1, column: 1 })
        return
      }
      editor.executeEdits('vim', [
        {
          range: {
            startLineNumber: insertLine,
            startColumn: 1,
            endLineNumber: insertLine,
            endColumn: 1,
          },
          text,
        },
      ])
      editor.pushUndoStop()
      setPosition({ line: insertLine, column: 1 })
      return
    }

    const lineLength = model.getLineContent(from.line).length
    const column = before ? from.column : Math.min(lineLength + 1, from.column + 1)
    editor.pushUndoStop()
    editor.executeEdits('vim', [
      {
        range: {
          startLineNumber: from.line,
          startColumn: column,
          endLineNumber: from.line,
          endColumn: column,
        },
        text: repeated,
      },
    ])
    editor.pushUndoStop()
    const firstLine = repeated.split('\n')
    const targetLine = from.line + firstLine.length - 1
    const targetColumn =
      firstLine.length === 1
        ? column + repeated.length
        : (firstLine[firstLine.length - 1]?.length ?? 0) + 1
    setPosition({ line: targetLine, column: targetColumn })
  }

  function primaryPosition(): VimPosition {
    const selection = (editor.getSelections() ?? [])[0]
    if (selection === undefined) return { line: 1, column: 1 }
    return { line: selection.startLineNumber, column: selection.startColumn }
  }

  function handleKeyDown(event: KeyboardEvent): boolean {
    if (!enabled || !textFocused) return false
    if (event.isComposing || event.keyCode === 229) return false
    const result = reduceVimKey(state, {
      key: event.key,
      ctrl: event.ctrlKey,
      alt: event.altKey,
      meta: event.metaKey,
      shift: event.shiftKey,
      repeat: event.repeat,
    })
    if (!result.handled) return false
    state = result.state
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    if (result.command !== null) executeCommand(result.command)
    syncContextKeys()
    syncStatusBar()
    return true
  }

  const focusSubscription = editor.onDidFocusEditorText(() => {
    textFocused = true
    syncContextKeys()
    syncStatusBar()
  })
  const blurSubscription = editor.onDidBlurEditorText(() => {
    textFocused = false
    state = { ...state, mode: 'normal', count: 0, pendingOperator: null, pendingG: false }
    syncContextKeys()
    syncStatusBar()
  })
  const modelSubscription = editor.onDidChangeModel(() => {
    state = INITIAL_VIM_STATE
    syncContextKeys()
    syncStatusBar()
  })
  disposables.push(focusSubscription, blurSubscription, modelSubscription)

  const configSubscription = configService.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('editor.vimMode.enabled')) {
      enabled = configService.get<boolean>('editor.vimMode.enabled') === true
      if (!enabled) {
        state = INITIAL_VIM_STATE
      }
      syncContextKeys()
      syncStatusBar()
      return
    }
    if (event.affectsConfiguration('editor.vimMode.showStatusBar')) {
      syncStatusBar()
    }
    if (event.affectsConfiguration('editor.vimMode.autoSwitchInputMethod')) {
      autoSwitchInputMethod =
        configService.get<boolean>('editor.vimMode.autoSwitchInputMethod') !== false
      syncInputMethod()
    }
  })
  disposables.push(configSubscription)

  syncContextKeys()

  return {
    editor,
    isEnabled: () => enabled,
    hasTextFocus: () => textFocused,
    handleKeyDown,
    dispose: () => {
      for (const disposable of disposables) disposable.dispose()
      disposables.length = 0
      disposeStatusEntry()
      // Only the controller holding text focus may leave English: main's saved
      // input method is shared, so a background group's disposal must not yank
      // Chinese back under the focused group.
      if (textFocused && inputMethodState === 'english') {
        inputMethodState = 'native'
        inputMethodChain = inputMethodChain
          .then(() => inputMethodService.restore())
          .catch(() => undefined)
      }
      // Only clear the keys this controller owns: another editor group's
      // controller may hold text focus right now.
      if (textFocused) {
        contextKeyService.set('vimNormalMode', false)
        contextKeyService.set('vimMode', '')
      }
    },
  }
}
