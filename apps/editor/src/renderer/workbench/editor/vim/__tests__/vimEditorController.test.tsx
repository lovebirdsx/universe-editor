/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { createVimEditorController } from '../vimEditorController.js'
import type { VimEditor, VimRange } from '../vimTypes.js'

interface FakeConfig {
  get<T>(key: string): T | undefined
  onDidChangeConfiguration(
    listener: (event: { affectsConfiguration(key: string): boolean }) => void,
  ): {
    dispose(): void
  }
  set(key: string, value: unknown): void
  fire(key: string): void
}

function createFakeConfig(initial: Record<string, unknown>): FakeConfig {
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
    set(key: string, value: unknown) {
      values[key] = value
    },
    fire(key: string) {
      for (const listener of listeners) {
        listener({ affectsConfiguration: (candidate) => candidate === key })
      }
    },
  }
}

function createFakeEditor(lines: string[]) {
  let selection: VimRange = {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 1,
  }
  const focusListeners: (() => void)[] = []
  const blurListeners: (() => void)[] = []
  const container = document.createElement('div')
  document.body.appendChild(container)
  const model = {
    getLineCount: () => lines.length,
    getLineContent: (line: number) => lines[line - 1] ?? '',
    getValueInRange: (range: VimRange) =>
      (lines[range.startLineNumber - 1] ?? '').slice(range.startColumn - 1, range.endColumn - 1),
    getEOL: () => '\n',
  }
  const editor: VimEditor = {
    getModel: () => model,
    getSelections: () => [selection],
    setPosition: vi.fn((position) => {
      selection = {
        startLineNumber: position.lineNumber,
        startColumn: position.column,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      }
    }),
    setSelections: vi.fn(),
    executeEdits: vi.fn(() => true),
    pushUndoStop: vi.fn(() => true),
    trigger: vi.fn(),
    revealPositionInCenterIfOutsideViewport: vi.fn(),
    getVisibleRanges: () => [
      { startLineNumber: 1, startColumn: 1, endLineNumber: 20, endColumn: 1 },
    ],
    getContainerDomNode: () => container,
    onDidFocusEditorText: (listener) => {
      focusListeners.push(listener)
      return { dispose: () => undefined }
    },
    onDidBlurEditorText: (listener) => {
      blurListeners.push(listener)
      return { dispose: () => undefined }
    },
    onDidChangeModel: () => ({ dispose: () => undefined }),
  }
  return {
    editor,
    focus: () => focusListeners.forEach((listener) => listener()),
    blur: () => blurListeners.forEach((listener) => listener()),
    selection: () => selection,
    container,
  }
}

function key(key: string, modifiers: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers })
}

function createContext() {
  const values = new Map<string, unknown>()
  return {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => {
      values.set(key, value)
    },
    values,
  }
}

function createStatusBar() {
  const records: { entry: unknown; disposed: boolean; updates: unknown[] }[] = []
  return {
    addEntry: (entry: unknown) => {
      const record = { entry, disposed: false, updates: [] as unknown[] }
      records.push(record)
      return {
        dispose: () => {
          record.disposed = true
        },
        update: (next: unknown) => {
          record.entry = next
          record.updates.push(next)
        },
      }
    },
    records,
  }
}

describe('createVimEditorController', () => {
  it('does nothing while disabled', () => {
    const fake = createFakeEditor(['abc', 'def'])
    const controller = createVimEditorController({
      editor: fake.editor,
      configService: createFakeConfig({}) as never,
      contextKeyService: createContext() as never,
      statusBarService: createStatusBar() as never,
    })
    fake.focus()
    expect(controller.handleKeyDown(key('j'))).toBe(false)
    controller.dispose()
  })

  it('moves and swallows Normal-mode keys when enabled', () => {
    const fake = createFakeEditor(['abc', 'def', 'ghi'])
    const controller = createVimEditorController({
      editor: fake.editor,
      configService: createFakeConfig({ 'editor.vimMode.enabled': true }) as never,
      contextKeyService: createContext() as never,
      statusBarService: createStatusBar() as never,
    })
    fake.focus()
    expect(controller.handleKeyDown(key('j'))).toBe(true)
    expect(fake.selection()).toEqual({
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 1,
    })
    controller.dispose()
  })

  it('switches to Insert on i and back on Escape', () => {
    const fake = createFakeEditor(['abc'])
    const context = createContext()
    const controller = createVimEditorController({
      editor: fake.editor,
      configService: createFakeConfig({ 'editor.vimMode.enabled': true }) as never,
      contextKeyService: context as never,
      statusBarService: createStatusBar() as never,
    })
    fake.focus()
    controller.handleKeyDown(key('i'))
    expect(context.get('vimMode')).toBe('insert')
    expect(context.get('vimNormalMode')).toBe(false)
    // Insert mode lets printable keys through.
    expect(controller.handleKeyDown(key('j'))).toBe(false)
    controller.handleKeyDown(key('Escape'))
    expect(context.get('vimMode')).toBe('normal')
    expect(context.get('vimNormalMode')).toBe(true)
    controller.dispose()
  })

  it('ignores IME composition strokes', () => {
    const fake = createFakeEditor(['abc'])
    const controller = createVimEditorController({
      editor: fake.editor,
      configService: createFakeConfig({ 'editor.vimMode.enabled': true }) as never,
      contextKeyService: createContext() as never,
      statusBarService: createStatusBar() as never,
    })
    fake.focus()
    expect(controller.handleKeyDown(key('j', { isComposing: true }))).toBe(false)
    controller.dispose()
  })

  it('resets to Normal when the configuration is disabled', () => {
    const fake = createFakeEditor(['abc'])
    const config = createFakeConfig({ 'editor.vimMode.enabled': true })
    const context = createContext()
    const controller = createVimEditorController({
      editor: fake.editor,
      configService: config as never,
      contextKeyService: context as never,
      statusBarService: createStatusBar() as never,
    })
    fake.focus()
    controller.handleKeyDown(key('i'))
    config.set('editor.vimMode.enabled', false)
    ;(config as unknown as { fire(key: string): void }).fire('editor.vimMode.enabled')
    expect(context.get('vimMode')).toBe('')
    expect(controller.handleKeyDown(key('j'))).toBe(false)
    controller.dispose()
  })

  it('joins as many lines as the count asks for', () => {
    const fake = createFakeEditor(['one', 'two', 'three', 'four'])
    const controller = createVimEditorController({
      editor: fake.editor,
      configService: createFakeConfig({ 'editor.vimMode.enabled': true }) as never,
      contextKeyService: createContext() as never,
      statusBarService: createStatusBar() as never,
    })
    fake.focus()
    vi.mocked(fake.editor.trigger).mockClear()

    controller.handleKeyDown(key('3'))
    controller.handleKeyDown(key('J'))

    expect(vi.mocked(fake.editor.trigger).mock.calls).toEqual([
      ['vim', 'editor.action.joinLines', null],
      ['vim', 'editor.action.joinLines', null],
    ])
    controller.dispose()
  })

  it('joins once for a bare J', () => {
    const fake = createFakeEditor(['one', 'two'])
    const controller = createVimEditorController({
      editor: fake.editor,
      configService: createFakeConfig({ 'editor.vimMode.enabled': true }) as never,
      contextKeyService: createContext() as never,
      statusBarService: createStatusBar() as never,
    })
    fake.focus()
    vi.mocked(fake.editor.trigger).mockClear()

    controller.handleKeyDown(key('J'))

    expect(vi.mocked(fake.editor.trigger).mock.calls).toEqual([
      ['vim', 'editor.action.joinLines', null],
    ])
    controller.dispose()
  })

  it('yanks a deleted line so p pastes it back', () => {
    const fake = createFakeEditor(['one', 'two', 'three'])
    const controller = createVimEditorController({
      editor: fake.editor,
      configService: createFakeConfig({ 'editor.vimMode.enabled': true }) as never,
      contextKeyService: createContext() as never,
      statusBarService: createStatusBar() as never,
    })
    fake.focus()
    controller.handleKeyDown(key('d'))
    controller.handleKeyDown(key('d'))
    vi.mocked(fake.editor.executeEdits).mockClear()

    controller.handleKeyDown(key('p'))

    // `dd` must land in the unnamed register (Vim yanks on delete), and a
    // linewise paste goes below the cursor as a whole line.
    expect(fake.editor.executeEdits).toHaveBeenCalledWith('vim', [
      {
        range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 },
        text: 'one\n',
      },
    ])
    controller.dispose()
  })
})
