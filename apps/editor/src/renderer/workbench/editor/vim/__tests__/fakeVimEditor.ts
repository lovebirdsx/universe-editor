/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  A text-applying fake of the Monaco editor for the controller's edit-level tests:
 *  `executeEdits` really rewrites the buffer, so operators, Visual actions and `.`
 *  can be asserted on the resulting lines instead of on the edit payloads.
 *
 *  It models the Monaco behaviour the controller leans on, so tests catch the bugs the
 *  real editor would: undo/redo grouped by `pushUndoStop` (restoring the selection that
 *  was live when the group began), direction-preserving selections, line access that
 *  throws out of range, ranges clamped like `validateRange`, content-change events,
 *  the core `type` / `deleteLeft` / `deleteRight` / `tab` handlers, closed folds and a
 *  read-only switch (`executeEdits` refuses, like the real widget).
 *--------------------------------------------------------------------------------------------*/

import { vi } from 'vitest'
import type { monaco } from '../../monaco/MonacoLoader.js'
import {
  createVimEditorController,
  type IVimEditorControllerOptions,
} from '../vimEditorController.js'
import type { VimEditor, VimRange, VimSelection } from '../vimTypes.js'

export interface FakeConfig {
  get<T>(key: string): T | undefined
  onDidChangeConfiguration(
    listener: (event: { affectsConfiguration(key: string): boolean }) => void,
  ): { dispose(): void }
  set(key: string, value: unknown): void
  fire(key: string): void
}

export function createFakeConfig(initial: Record<string, unknown>): FakeConfig {
  const values = { ...initial }
  const listeners = new Set<(event: { affectsConfiguration(key: string): boolean }) => void>()
  return {
    get<T>(key: string): T | undefined {
      return values[key] as T | undefined
    },
    onDidChangeConfiguration(listener) {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    set(key, value) {
      values[key] = value
    },
    fire(key) {
      for (const listener of listeners) {
        listener({ affectsConfiguration: (candidate) => candidate === key })
      }
    },
  }
}

interface Cursor {
  anchorLine: number
  anchorColumn: number
  line: number
  column: number
}

interface Snapshot {
  lines: string[]
  cursors: Cursor[]
}

export interface FakeFold {
  readonly start: number
  readonly end: number
  readonly collapsed: boolean
}

const cloneCursors = (cursors: readonly Cursor[]): Cursor[] =>
  cursors.map((cursor) => ({ ...cursor }))

export function createTextEditor(initial: string[], doc: Document = document) {
  let lines = [...initial]
  let cursors: Cursor[] = [{ anchorLine: 1, anchorColumn: 1, line: 1, column: 1 }]
  let readOnly = false
  let folds: readonly FakeFold[] | null = null
  const focusListeners: (() => void)[] = []
  const blurListeners: (() => void)[] = []
  const modelListeners: (() => void)[] = []
  const contentListeners: (() => void)[] = []
  const container = doc.createElement('div')
  doc.body.appendChild(container)

  // Undo history: a snapshot is taken by the first edit after a stop, like Monaco's
  // undo elements. `groupOpen` stays true until `pushUndoStop`.
  const undoStack: Snapshot[] = []
  const redoStack: Snapshot[] = []
  let groupOpen = false

  const lineCount = (): number => lines.length
  const lineAt = (line: number): string => {
    if (line < 1 || line > lines.length) {
      throw new Error(`Illegal value for lineNumber: ${line} (line count ${lines.length})`)
    }
    return lines[line - 1] ?? ''
  }
  const validLine = (line: number): number => Math.max(1, Math.min(lines.length, line))
  const validColumn = (line: number, column: number): number =>
    Math.max(1, Math.min((lines[line - 1] ?? '').length + 1, column))
  const offsetOf = (line: number, column: number): number => {
    const l = validLine(line)
    const c = validColumn(l, column)
    let offset = 0
    for (let index = 0; index < l - 1; index++) offset += (lines[index] ?? '').length + 1
    return offset + c - 1
  }
  const positionOfOffset = (offset: number): { line: number; column: number } => {
    let remaining = offset
    for (let index = 0; index < lines.length; index++) {
      const length = (lines[index] ?? '').length
      if (remaining <= length) return { line: index + 1, column: remaining + 1 }
      remaining -= length + 1
    }
    const last = lines.length
    return { line: last, column: (lines[last - 1] ?? '').length + 1 }
  }
  const text = () => lines.join('\n')
  const fireContent = (): void => contentListeners.slice().forEach((listener) => listener())

  const model = {
    getLineCount: lineCount,
    getLineContent: lineAt,
    getValueInRange: (range: VimRange) => {
      const a = offsetOf(range.startLineNumber, range.startColumn)
      const b = offsetOf(range.endLineNumber, range.endColumn)
      return text().slice(Math.min(a, b), Math.max(a, b))
    },
    getEOL: () => '\n',
  }

  const clamp = (): void => {
    cursors = cursors.map((cursor) => {
      const line = validLine(cursor.line)
      const column = validColumn(line, cursor.column)
      const anchorLine = validLine(cursor.anchorLine)
      return {
        line,
        column,
        anchorLine,
        anchorColumn: validColumn(anchorLine, cursor.anchorColumn),
      }
    })
  }

  const beginEdit = (): void => {
    if (groupOpen) return
    undoStack.push({ lines: [...lines], cursors: cloneCursors(cursors) })
    redoStack.length = 0
    groupOpen = true
  }

  const applyEdits = (edits: { range: VimRange; text: string | null }[]): void => {
    beginEdit()
    const source = text()
    const resolved = edits
      .map((edit) => {
        const a = offsetOf(edit.range.startLineNumber, edit.range.startColumn)
        const b = offsetOf(edit.range.endLineNumber, edit.range.endColumn)
        return { start: Math.min(a, b), end: Math.max(a, b), text: edit.text ?? '' }
      })
      .sort((a, b) => b.start - a.start)
    let next = source
    for (const edit of resolved) next = next.slice(0, edit.start) + edit.text + next.slice(edit.end)
    lines = next.split('\n')
    clamp()
    fireContent()
  }

  const setCaret = (line: number, column: number): void => {
    cursors = [{ anchorLine: line, anchorColumn: column, line, column }]
    clamp()
  }

  const selectionRange = (cursor: Cursor): { start: number; end: number } => {
    const a = offsetOf(cursor.anchorLine, cursor.anchorColumn)
    const b = offsetOf(cursor.line, cursor.column)
    return { start: Math.min(a, b), end: Math.max(a, b) }
  }

  /**
   * Run an edit at every cursor (the core typing handlers). `compute` returns the
   * replaced offsets and text; the cursor lands after the inserted text.
   */
  const editAtCursors = (
    compute: (
      cursor: Cursor,
      start: number,
      end: number,
    ) => { start: number; end: number; text: string } | null,
  ): void => {
    beginEdit()
    const planned = cursors
      .map((cursor, index) => {
        const { start, end } = selectionRange(cursor)
        return { index, edit: compute(cursor, start, end) }
      })
      .sort((a, b) => (a.edit?.start ?? 0) - (b.edit?.start ?? 0))
    const source = text()
    let out = ''
    let consumed = 0
    let shift = 0
    const landing = new Map<number, number>()
    for (const { index, edit } of planned) {
      if (edit === null) continue
      out += source.slice(consumed, edit.start) + edit.text
      consumed = edit.end
      landing.set(index, edit.start + shift + edit.text.length)
      shift += edit.text.length - (edit.end - edit.start)
    }
    out += source.slice(consumed)
    lines = out.split('\n')
    cursors = cursors.map((cursor, index) => {
      const offset = landing.get(index)
      if (offset === undefined) return cursor
      const at = positionOfOffset(offset)
      return { anchorLine: at.line, anchorColumn: at.column, line: at.line, column: at.column }
    })
    clamp()
    fireContent()
  }

  const typeAtCursors = (value: string, autoIndent: boolean): void => {
    // Monaco's `type` command handles one character at a time.
    for (const char of Array.from(value)) {
      editAtCursors((cursor, start, end) => {
        const indent =
          autoIndent && char === '\n'
            ? ((lines[cursor.line - 1] ?? '').match(/^[ \t]*/)?.[0] ?? '')
            : ''
        return { start, end, text: char + indent }
      })
    }
  }

  const deleteAtCursors = (backward: boolean): void => {
    editAtCursors((_cursor, start, end) => {
      if (start !== end) return { start, end, text: '' }
      if (backward) return start === 0 ? null : { start: start - 1, end, text: '' }
      return end >= text().length ? null : { start, end: end + 1, text: '' }
    })
  }

  const undo = (): void => {
    const snapshot = undoStack.pop()
    groupOpen = false
    if (snapshot === undefined) return
    redoStack.push({ lines: [...lines], cursors: cloneCursors(cursors) })
    lines = [...snapshot.lines]
    cursors = cloneCursors(snapshot.cursors)
    fireContent()
  }

  const redo = (): void => {
    const snapshot = redoStack.pop()
    groupOpen = false
    if (snapshot === undefined) return
    undoStack.push({ lines: [...lines], cursors: cloneCursors(cursors) })
    lines = [...snapshot.lines]
    cursors = cloneCursors(snapshot.cursors)
    fireContent()
  }

  const triggers: [string, string][] = []
  const trigger = vi.fn((source: string, handler: string, payload?: unknown) => {
    triggers.push([source, handler])
    const cursor = cursors[0]!
    switch (handler) {
      case 'undo':
        undo()
        break
      case 'redo':
        redo()
        break
      case 'type':
        typeAtCursors((payload as { text: string }).text, source === 'keyboard')
        break
      case 'deleteLeft':
        deleteAtCursors(true)
        break
      case 'deleteRight':
        deleteAtCursors(false)
        break
      case 'tab':
        typeAtCursors('\t', false)
        break
      case 'editor.action.insertLineAfter':
        beginEdit()
        lines.splice(cursor.line, 0, '')
        setCaret(cursor.line + 1, 1)
        fireContent()
        break
      case 'editor.action.insertLineBefore':
        beginEdit()
        lines.splice(cursor.line - 1, 0, '')
        setCaret(cursor.line, 1)
        fireContent()
        break
      case 'editor.action.indentLines':
      case 'editor.action.outdentLines': {
        beginEdit()
        const top = Math.min(cursor.anchorLine, cursor.line)
        const bottom = Math.max(cursor.anchorLine, cursor.line)
        for (let line = top; line <= bottom; line++) {
          const content = lines[line - 1] ?? ''
          lines[line - 1] =
            handler === 'editor.action.indentLines'
              ? `  ${content}`
              : content.replace(/^ {1,2}/, '')
        }
        fireContent()
        break
      }
      default:
        break
    }
  })

  const foldingRegionsAt = (line: number) =>
    (folds ?? [])
      .filter((fold) => fold.start <= line && line <= fold.end)
      .sort((a, b) => a.end - a.start - (b.end - b.start))
      .map((fold) => ({
        startLineNumber: fold.start,
        endLineNumber: fold.end,
        isCollapsed: fold.collapsed,
      }))

  const editor: VimEditor = {
    getModel: () => model,
    getSelections: () =>
      cursors.map((cursor) => {
        const forward =
          cursor.anchorLine < cursor.line ||
          (cursor.anchorLine === cursor.line && cursor.anchorColumn <= cursor.column)
        const start = forward
          ? { line: cursor.anchorLine, column: cursor.anchorColumn }
          : { line: cursor.line, column: cursor.column }
        const end = forward
          ? { line: cursor.line, column: cursor.column }
          : { line: cursor.anchorLine, column: cursor.anchorColumn }
        // Like Monaco's `Selection`: the range plus the direction-carrying anchor / position.
        return {
          startLineNumber: start.line,
          startColumn: start.column,
          endLineNumber: end.line,
          endColumn: end.column,
          selectionStartLineNumber: cursor.anchorLine,
          selectionStartColumn: cursor.anchorColumn,
          positionLineNumber: cursor.line,
          positionColumn: cursor.column,
        }
      }),
    setPosition: vi.fn((position) => setCaret(position.lineNumber, position.column)),
    setSelections: vi.fn((selections: VimSelection[]) => {
      cursors = selections.map((selection) => ({
        anchorLine: selection.selectionStartLineNumber,
        anchorColumn: selection.selectionStartColumn,
        line: selection.positionLineNumber,
        column: selection.positionColumn,
      }))
      clamp()
    }),
    executeEdits: vi.fn((_source: string, edits) => {
      if (readOnly) return false
      applyEdits(edits)
      return true
    }),
    pushUndoStop: vi.fn(() => {
      groupOpen = false
      return true
    }),
    trigger,
    revealPositionInCenterIfOutsideViewport: vi.fn(),
    getTopForLineNumber: (line: number) => (line - 1) * 20,
    getBottomForLineNumber: (line: number) => line * 20,
    setScrollTop: vi.fn(),
    getLayoutInfo: () => ({ height: 400 }),
    getContribution: <T extends monaco.editor.IEditorContribution>(id: string): T | null =>
      (id === 'editor.contrib.folding' && folds !== null
        ? { foldingModel: { getAllRegionsAtLine: foldingRegionsAt } }
        : null) as T | null,
    getVisibleRanges: () => [
      { startLineNumber: 1, startColumn: 1, endLineNumber: 20, endColumn: 1 },
    ],
    getContainerDomNode: () => container,
    updateOptions: vi.fn(),
    onDidFocusEditorText: (listener) => {
      focusListeners.push(listener)
      return { dispose: () => undefined }
    },
    onDidBlurEditorText: (listener) => {
      blurListeners.push(listener)
      return { dispose: () => undefined }
    },
    onDidChangeModel: (listener) => {
      modelListeners.push(listener)
      return { dispose: () => undefined }
    },
    onDidChangeModelContent: (listener) => {
      contentListeners.push(listener)
      return {
        dispose: () => {
          const index = contentListeners.indexOf(listener)
          if (index >= 0) contentListeners.splice(index, 1)
        },
      }
    },
    focus: vi.fn(() => focusListeners.forEach((listener) => listener())),
    addOverlayWidget: vi.fn((widget: monaco.editor.IOverlayWidget) =>
      container.appendChild(widget.getDomNode()),
    ),
    removeOverlayWidget: vi.fn((widget: monaco.editor.IOverlayWidget) =>
      widget.getDomNode().remove(),
    ),
    createDecorationsCollection: vi.fn(
      () =>
        ({
          set: () => [],
          clear: () => undefined,
        }) as unknown as monaco.editor.IEditorDecorationsCollection,
    ),
  }

  const rangeOfSelection = (index: number): VimRange => {
    const selection = editor.getSelections()![index]!
    return {
      startLineNumber: selection.startLineNumber,
      startColumn: selection.startColumn,
      endLineNumber: selection.endLineNumber,
      endColumn: selection.endColumn,
    }
  }

  return {
    editor,
    focus: () => focusListeners.forEach((listener) => listener()),
    blur: () => blurListeners.forEach((listener) => listener()),
    modelChange: () => modelListeners.forEach((listener) => listener()),
    lines: () => [...lines],
    text,
    cursor: () => ({ line: cursors[0]!.line, column: cursors[0]!.column }),
    cursors: () => cursors.map((cursor) => ({ line: cursor.line, column: cursor.column })),
    /** The primary selection as a range (start <= end). */
    selection: () => rangeOfSelection(0),
    selections: () => cursors.map((_cursor, index) => rangeOfSelection(index)),
    /** The primary selection with its direction: anchor (`selectionStart*`) and moving end (`position*`). */
    directedSelection: () => editor.getSelections()![0]! as VimSelection & VimRange,
    setCursor: (line: number, column: number) => setCaret(line, column),
    triggers: () => [...triggers],
    /** Mark closed / open fold regions, innermost first when nested. */
    setFolds: (regions: readonly FakeFold[] | null) => {
      folds = regions
    },
    setReadOnly: (value: boolean) => {
      readOnly = value
    },
    isReadOnly: () => readOnly,
    /** Undo stops currently recorded (one per undoable group). */
    undoDepth: () => undoStack.length,
    /** Simulate typing in Insert mode at every cursor, bypassing keydown (no auto-indent). */
    typeText: (value: string) => typeAtCursors(value, false),
    /** Monaco's default action for a key Vim did not consume while in Insert mode. */
    defaultKeyAction(init: KeyboardEventInit) {
      const key = init.key ?? ''
      if (key === 'Enter') typeAtCursors('\n', true)
      else if (key === 'Backspace') deleteAtCursors(true)
      else if (key === 'Delete') deleteAtCursors(false)
      else if (key === 'Tab') typeAtCursors('\t', false)
      else if (key === 'ArrowLeft' || key === 'ArrowRight') {
        const at = positionOfOffset(
          Math.max(
            0,
            Math.min(
              text().length,
              offsetOf(cursors[0]!.line, cursors[0]!.column) + (key === 'ArrowLeft' ? -1 : 1),
            ),
          ),
        )
        setCaret(at.line, at.column)
      } else if (key === 'ArrowUp' || key === 'ArrowDown') {
        const line = validLine(cursors[0]!.line + (key === 'ArrowUp' ? -1 : 1))
        setCaret(line, cursors[0]!.column)
      } else if (Array.from(key).length === 1 && init.ctrlKey !== true) typeAtCursors(key, true)
    },
  }
}

export function createVimModeServiceFake() {
  const modes = new Map<string, string>()
  return {
    _serviceBrand: undefined,
    modes,
    activeSurface: undefined,
    onDidChangeMode: () => ({ dispose: () => undefined }),
    getEnabled: () => true,
    getMode: (key: string, fallback: string) => modes.get(key) ?? fallback,
    setMode: (key: string, mode: string) => {
      modes.set(key, mode)
    },
    setPendingKeys: vi.fn(),
    reportUnsupportedKey: vi.fn(),
    setEditorSubMode: vi.fn(),
    isSurfaceEnabled: () => true,
  }
}

export function createInputMethodFake() {
  return {
    switchToEnglish: vi.fn(async () => true),
    restore: vi.fn(async () => undefined),
  }
}

const TOKEN = /<[^>\s]+>|[\s\S]/gu

/** `ciw` → one key per character; `<Esc>`, `<C-v>`, `<CR>`, `<S-Tab>`… are single keys. */
export function parseKeys(input: string): KeyboardEventInit[] {
  const named: Record<string, string> = {
    Esc: 'Escape',
    CR: 'Enter',
    BS: 'Backspace',
    Del: 'Delete',
    Space: ' ',
    lt: '<',
    Left: 'ArrowLeft',
    Right: 'ArrowRight',
    Up: 'ArrowUp',
    Down: 'ArrowDown',
  }
  return [...input.matchAll(TOKEN)].map(([token]) => {
    if (token.length > 1 && token.startsWith('<') && token.endsWith('>')) {
      const body = token.slice(1, -1)
      const ctrl = body.startsWith('C-')
      const name = ctrl ? body.slice(2) : body
      return { key: named[name] ?? name, ctrlKey: ctrl }
    }
    return { key: token }
  })
}

export interface VimHarnessOptions {
  readonly config?: Record<string, unknown>
  readonly controller?: Partial<IVimEditorControllerOptions>
  readonly readOnly?: boolean
}

export function createVimHarness(lines: string[], options: VimHarnessOptions = {}) {
  const fake = createTextEditor(lines)
  if (options.readOnly === true) fake.setReadOnly(true)
  const vim = createVimModeServiceFake()
  const inputMethod = createInputMethodFake()
  const config = createFakeConfig({ 'vim.enabled': true, ...options.config })
  const callbacks = {
    onPendingKeysChange: vi.fn<(keys: string) => void>(),
    onUnsupportedKey: vi.fn<(key: string) => void>(),
    onSubModeChange: vi.fn<(mode: string) => void>(),
  }
  const controller = createVimEditorController({
    editor: fake.editor,
    surfaceKey: 'editor:test',
    configService: config as never,
    contextKeyService: { get: () => undefined, set: () => undefined } as never,
    vimModeService: vim as never,
    inputMethodService: inputMethod as never,
    isReadOnly: () => fake.isReadOnly(),
    ...callbacks,
    ...options.controller,
  })
  fake.focus()
  const dispatch = (init: KeyboardEventInit): boolean =>
    controller.handleKeyDown(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    )
  /** Send keys; returns whether the last one was consumed. */
  const keys = (input: string): boolean => {
    let handled = false
    for (const init of parseKeys(input)) handled = dispatch(init)
    return handled
  }
  /**
   * Type like a user: every key goes through the controller first, and what Vim does
   * not consume (Insert mode) gets Monaco's default action, so key-recorded `.` replay
   * and auto-indent behave as in the real editor.
   */
  const type = (input: string): void => {
    for (const init of parseKeys(input)) {
      if (!dispatch(init)) fake.defaultKeyAction(init)
    }
  }
  return { fake, vim, inputMethod, config, controller, keys, type, callbacks }
}
