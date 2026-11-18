/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { monaco } from '../../monaco/MonacoLoader.js'
import { createVimEditorController } from '../vimEditorController.js'
import { getLastVimSearch, resetVimSearchForTests } from '../vimSearch.js'
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

function createFakeEditor(lines: string[], doc: Document = document) {
  let selection: VimRange = {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 1,
  }
  const focusListeners: (() => void)[] = []
  const blurListeners: (() => void)[] = []
  const modelListeners: (() => void)[] = []
  const overlays: monaco.editor.IOverlayWidget[] = []
  const decorationSets: monaco.editor.IModelDeltaDecoration[][] = []
  let decorationClears = 0
  const container = doc.createElement('div')
  doc.body.appendChild(container)
  const model = {
    getLineCount: () => lines.length,
    getLineContent: (line: number) => lines[line - 1] ?? '',
    getValueInRange: (range: VimRange) =>
      (lines[range.startLineNumber - 1] ?? '').slice(range.startColumn - 1, range.endColumn - 1),
    getEOL: () => '\n',
  }
  const decorations = {
    set: vi.fn((next: monaco.editor.IModelDeltaDecoration[]) => {
      decorationSets.push(next)
      return []
    }),
    clear: vi.fn(() => {
      decorationClears++
    }),
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
    onDidChangeModel: (listener) => {
      modelListeners.push(listener)
      return { dispose: () => undefined }
    },
    focus: vi.fn(() => {
      focusListeners.forEach((listener) => listener())
    }),
    addOverlayWidget: vi.fn((widget: monaco.editor.IOverlayWidget) => {
      overlays.push(widget)
      container.appendChild(widget.getDomNode())
    }),
    removeOverlayWidget: vi.fn((widget: monaco.editor.IOverlayWidget) => {
      const index = overlays.indexOf(widget)
      if (index >= 0) overlays.splice(index, 1)
      widget.getDomNode().remove()
    }),
    createDecorationsCollection: vi.fn(
      () => decorations as unknown as monaco.editor.IEditorDecorationsCollection,
    ),
  }
  return {
    editor,
    focus: () => focusListeners.forEach((listener) => listener()),
    blur: () => blurListeners.forEach((listener) => listener()),
    modelChange: () => modelListeners.forEach((listener) => listener()),
    selection: () => selection,
    container,
    overlays: () => overlays,
    decorationSets: () => decorationSets,
    decorationClears: () => decorationClears,
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

function createInputMethodService() {
  return {
    switchToEnglish: vi.fn(async () => true),
    restore: vi.fn(async () => undefined),
  }
}

describe('createVimEditorController', () => {
  beforeEach(() => resetVimSearchForTests())

  it('does nothing while disabled', () => {
    const fake = createFakeEditor(['abc', 'def'])
    const controller = createVimEditorController({
      editor: fake.editor,
      configService: createFakeConfig({}) as never,
      contextKeyService: createContext() as never,
      statusBarService: createStatusBar() as never,
      inputMethodService: createInputMethodService() as never,
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
      inputMethodService: createInputMethodService() as never,
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

  it('moves with navigation keys in Normal mode and leaves F-keys to the workbench', () => {
    const fake = createFakeEditor(['abc', '  def', 'ghi'])
    const controller = createVimEditorController({
      editor: fake.editor,
      configService: createFakeConfig({ 'editor.vimMode.enabled': true }) as never,
      contextKeyService: createContext() as never,
      statusBarService: createStatusBar() as never,
      inputMethodService: createInputMethodService() as never,
    })
    fake.focus()

    expect(controller.handleKeyDown(key('ArrowDown'))).toBe(true)
    expect(fake.selection()).toMatchObject({ startLineNumber: 2, startColumn: 1 })
    expect(controller.handleKeyDown(key('End'))).toBe(true)
    expect(fake.selection()).toMatchObject({ startLineNumber: 2, startColumn: 5 })
    expect(controller.handleKeyDown(key('Home'))).toBe(true)
    expect(fake.selection()).toMatchObject({ startLineNumber: 2, startColumn: 1 })
    expect(controller.handleKeyDown(key('PageDown'))).toBe(true)
    expect(fake.selection()).toMatchObject({ startLineNumber: 3 })
    expect(controller.handleKeyDown(key('PageUp'))).toBe(true)
    expect(fake.selection()).toMatchObject({ startLineNumber: 1 })

    // F2 must reach the workbench/Monaco instead of being swallowed.
    expect(controller.handleKeyDown(key('F2'))).toBe(false)

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
      inputMethodService: createInputMethodService() as never,
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
      inputMethodService: createInputMethodService() as never,
    })
    fake.focus()
    expect(controller.handleKeyDown(key('j', { isComposing: true }))).toBe(false)
    controller.dispose()
  })

  it('switches the input method to English in Normal mode and restores it in Insert', async () => {
    const fake = createFakeEditor(['abc'])
    const inputMethod = createInputMethodService()
    const controller = createVimEditorController({
      editor: fake.editor,
      configService: createFakeConfig({ 'editor.vimMode.enabled': true }) as never,
      contextKeyService: createContext() as never,
      statusBarService: createStatusBar() as never,
      inputMethodService: inputMethod as never,
    })
    fake.focus()
    await vi.waitFor(() => expect(inputMethod.switchToEnglish).toHaveBeenCalledTimes(1))

    controller.handleKeyDown(key('i'))
    await vi.waitFor(() => expect(inputMethod.restore).toHaveBeenCalledTimes(1))

    controller.handleKeyDown(key('Escape'))
    await vi.waitFor(() => expect(inputMethod.switchToEnglish).toHaveBeenCalledTimes(2))
    controller.dispose()
  })

  it('restores the input method when the editor loses text focus', async () => {
    const fake = createFakeEditor(['abc'])
    const inputMethod = createInputMethodService()
    const controller = createVimEditorController({
      editor: fake.editor,
      configService: createFakeConfig({ 'editor.vimMode.enabled': true }) as never,
      contextKeyService: createContext() as never,
      statusBarService: createStatusBar() as never,
      inputMethodService: inputMethod as never,
    })
    fake.focus()
    await vi.waitFor(() => expect(inputMethod.switchToEnglish).toHaveBeenCalledTimes(1))

    fake.blur()
    await vi.waitFor(() => expect(inputMethod.restore).toHaveBeenCalledTimes(1))
    controller.dispose()
  })

  it('leaves the input method alone when auto-switching is disabled', async () => {
    const fake = createFakeEditor(['abc'])
    const inputMethod = createInputMethodService()
    const controller = createVimEditorController({
      editor: fake.editor,
      configService: createFakeConfig({
        'editor.vimMode.enabled': true,
        'editor.vimMode.autoSwitchInputMethod': false,
      }) as never,
      contextKeyService: createContext() as never,
      statusBarService: createStatusBar() as never,
      inputMethodService: inputMethod as never,
    })
    fake.focus()
    await Promise.resolve()
    expect(inputMethod.switchToEnglish).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('shows the icon entry for an editor in an auxiliary-window document', () => {
    // Auxiliary windows portal their editor DOM into a separate document but
    // share the main renderer's status-bar service; the entry must follow that
    // editor's focus too (regression: it used to be limited to the main document).
    const auxDocument = document.implementation.createHTMLDocument('auxiliary')
    const fake = createFakeEditor(['abc'], auxDocument)
    const statusBar = createStatusBar()
    const controller = createVimEditorController({
      editor: fake.editor,
      configService: createFakeConfig({ 'editor.vimMode.enabled': true }) as never,
      contextKeyService: createContext() as never,
      statusBarService: statusBar as never,
      inputMethodService: createInputMethodService() as never,
    })

    fake.focus()

    expect(statusBar.records).toHaveLength(1)
    expect(statusBar.records[0]?.entry).toMatchObject({
      icon: 'vim-normal',
      text: '',
      alignment: 1,
    })
    controller.handleKeyDown(key('i'))
    expect(statusBar.records[0]?.entry).toMatchObject({ icon: 'vim-insert' })
    controller.dispose()
    auxDocument.body.removeChild(fake.container)
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
      inputMethodService: createInputMethodService() as never,
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
      inputMethodService: createInputMethodService() as never,
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
      inputMethodService: createInputMethodService() as never,
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
      inputMethodService: createInputMethodService() as never,
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

  function createSearchHarness(lines: string[]) {
    const fake = createFakeEditor(lines)
    const context = createContext()
    const controller = createVimEditorController({
      editor: fake.editor,
      configService: createFakeConfig({ 'editor.vimMode.enabled': true }) as never,
      contextKeyService: context as never,
      statusBarService: createStatusBar() as never,
      inputMethodService: createInputMethodService() as never,
    })
    fake.focus()
    return { fake, controller, context }
  }

  async function openSearchBox(
    fake: ReturnType<typeof createFakeEditor>,
    controller: ReturnType<typeof createVimEditorController>,
    keyValue: string,
  ): Promise<HTMLInputElement> {
    expect(controller.handleKeyDown(key(keyValue))).toBe(true)
    const overlay = fake.overlays()[0]
    expect(overlay).toBeDefined()
    const input = overlay!.getDomNode().querySelector('input')
    expect(input).not.toBeNull()
    await vi.waitFor(() => expect(document.activeElement).toBe(input))
    // The real editor loses text focus when the input takes it; mirror that so
    // the controller stops claiming Normal-mode strokes while typing.
    fake.blur()
    return input as HTMLInputElement
  }

  function type(input: HTMLInputElement, value: string): void {
    input.value = value
    input.dispatchEvent(new Event('input'))
  }

  function press(input: HTMLInputElement, keyValue: string): void {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: keyValue, bubbles: true, cancelable: true }),
    )
  }

  it('opens a find-style box, previews matches and commits on Enter', async () => {
    const { fake, controller, context } = createSearchHarness(['one foo', 'two foo', 'three foo'])
    const input = await openSearchBox(fake, controller, '/')
    expect(input.closest('.vim-search-widget')).not.toBeNull()
    expect(context.get('vimSearchFocused')).toBe(true)

    type(input, 'foo')
    expect(fake.selection()).toMatchObject({ startLineNumber: 1, startColumn: 5 })
    expect(fake.decorationSets().at(-1)?.[0]?.options).toMatchObject({
      inlineClassName: 'vim-search-match',
    })

    press(input, 'Enter')
    expect(fake.overlays()[0]?.getDomNode().hidden).toBe(true)
    expect(fake.editor.focus).toHaveBeenCalled()
    expect(fake.selection()).toMatchObject({ startLineNumber: 1, startColumn: 5 })
    expect(context.get('vimSearchFocused')).toBe(false)
    controller.dispose()
  })

  it('repeats with n / N, honors counts and wraps', async () => {
    const { fake, controller } = createSearchHarness(['foo', 'foo', 'foo', 'foo'])
    const input = await openSearchBox(fake, controller, '/')
    type(input, 'foo')
    // `/` skips the match under the cursor, exactly like Vim.
    press(input, 'Enter')
    expect(fake.selection()).toMatchObject({ startLineNumber: 2, startColumn: 1 })

    controller.handleKeyDown(key('n'))
    expect(fake.selection()).toMatchObject({ startLineNumber: 3, startColumn: 1 })
    controller.handleKeyDown(key('3'))
    controller.handleKeyDown(key('n'))
    expect(fake.selection()).toMatchObject({ startLineNumber: 2, startColumn: 1 })
    controller.handleKeyDown(key('N'))
    expect(fake.selection()).toMatchObject({ startLineNumber: 1, startColumn: 1 })
    controller.dispose()
  })

  it('searches backward with ? and wraps', async () => {
    const { fake, controller } = createSearchHarness(['foo', 'foo', 'foo'])
    controller.handleKeyDown(key('G'))
    const input = await openSearchBox(fake, controller, '?')
    type(input, 'foo')
    press(input, 'Enter')
    // `?` skips the match under the cursor and lands on the previous one.
    expect(fake.selection()).toMatchObject({ startLineNumber: 2, startColumn: 1 })

    controller.handleKeyDown(key('n'))
    expect(fake.selection()).toMatchObject({ startLineNumber: 1, startColumn: 1 })
    controller.handleKeyDown(key('n'))
    expect(fake.selection()).toMatchObject({ startLineNumber: 3, startColumn: 1 })
    controller.handleKeyDown(key('n'))
    expect(fake.selection()).toMatchObject({ startLineNumber: 2, startColumn: 1 })
    controller.dispose()
  })

  it('restores the origin on Escape', async () => {
    const { fake, controller } = createSearchHarness(['foo bar', 'foo baz'])
    controller.handleKeyDown(key('j'))
    controller.handleKeyDown(key('$'))
    const origin = fake.selection()
    const input = await openSearchBox(fake, controller, '/')
    type(input, 'foo')
    expect(fake.selection()).toMatchObject({ startLineNumber: 1, startColumn: 1 })

    press(input, 'Escape')
    expect(fake.selection()).toEqual(origin)
    expect(fake.overlays()[0]?.getDomNode().hidden).toBe(true)
    expect(fake.editor.focus).toHaveBeenCalled()
    controller.dispose()
  })

  it('keeps the box open and shows a hint when nothing matches', async () => {
    const { fake, controller } = createSearchHarness(['foo'])
    const input = await openSearchBox(fake, controller, '/')
    type(input, 'zzz')
    const node = fake.overlays()[0]!.getDomNode()
    expect(node.querySelector('.vim-search-hint')?.textContent).toBeTruthy()
    expect(fake.selection()).toMatchObject({ startLineNumber: 1, startColumn: 1 })

    press(input, 'Enter')
    expect(node.hidden).toBe(false)
    expect(node.querySelector('.vim-search-hint')?.textContent).toBeTruthy()
    controller.dispose()
  })

  it('reuses the last pattern for an empty Enter', async () => {
    const { fake, controller } = createSearchHarness(['foo', 'foo'])
    let input = await openSearchBox(fake, controller, '/')
    type(input, 'foo')
    press(input, 'Enter')

    input = await openSearchBox(fake, controller, '/')
    press(input, 'Enter')
    expect(fake.selection()).toMatchObject({ startLineNumber: 1, startColumn: 1 })
    controller.handleKeyDown(key('n'))
    expect(fake.selection()).toMatchObject({ startLineNumber: 2, startColumn: 1 })
    controller.dispose()
  })

  it('commits the visible preview when the box loses focus', async () => {
    const { fake, controller, context } = createSearchHarness(['foo bar'])
    const input = await openSearchBox(fake, controller, '/')
    type(input, 'foo')
    const clears = fake.decorationClears()

    input.dispatchEvent(new Event('blur'))
    expect(fake.overlays()[0]?.getDomNode().hidden).toBe(true)
    // The confirmed match stays marked; only an explicit cancel clears it.
    expect(fake.decorationClears()).toBe(clears)
    expect(getLastVimSearch()).toEqual({ text: 'foo', direction: 'forward' })
    expect(fake.selection()).toMatchObject({ startLineNumber: 1, startColumn: 1 })
    expect(context.get('vimSearchFocused')).toBe(false)
    controller.dispose()
  })

  it('restores the origin when blurring with no match', async () => {
    const { fake, controller } = createSearchHarness(['foo bar'])
    controller.handleKeyDown(key('l'))
    controller.handleKeyDown(key('l'))
    const origin = fake.selection()
    const input = await openSearchBox(fake, controller, '/')
    type(input, 'zzz')

    input.dispatchEvent(new Event('blur'))
    expect(fake.overlays()[0]?.getDomNode().hidden).toBe(true)
    expect(fake.selection()).toEqual(origin)
    controller.dispose()
  })

  it('ignores input events while the IME composition is still open', async () => {
    const { fake, controller } = createSearchHarness(['foo', 'foo'])
    const input = await openSearchBox(fake, controller, '/')

    input.value = 'fo'
    const composing = new Event('input') as InputEvent
    Object.defineProperty(composing, 'isComposing', { value: true })
    input.dispatchEvent(composing)
    expect(fake.selection()).toMatchObject({ startLineNumber: 1, startColumn: 1 })

    type(input, 'foo')
    expect(fake.selection()).toMatchObject({ startLineNumber: 2, startColumn: 1 })
    controller.dispose()
  })

  it('swallows the Find family keys while the box owns focus', async () => {
    const { fake, controller } = createSearchHarness(['foo bar', 'foo baz'])
    const input = await openSearchBox(fake, controller, '/')
    type(input, 'foo')
    const before = fake.selection()

    const event = new KeyboardEvent('keydown', {
      key: 'f',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    input.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(fake.overlays()[0]?.getDomNode().hidden).toBe(false)
    expect(input.value).toBe('foo')
    expect(fake.selection()).toEqual(before)
    controller.dispose()
  })

  it('applies a count typed before / to the search', async () => {
    const { fake, controller } = createSearchHarness(['foo', 'foo', 'foo', 'foo'])
    controller.handleKeyDown(key('3'))
    const input = await openSearchBox(fake, controller, '/')
    type(input, 'foo')
    expect(fake.selection()).toMatchObject({ startLineNumber: 4, startColumn: 1 })

    press(input, 'Enter')
    expect(fake.selection()).toMatchObject({ startLineNumber: 4, startColumn: 1 })
    controller.dispose()
  })

  it('cleans up on model change, disable and dispose', async () => {
    const fake = createFakeEditor(['foo'])
    const config = createFakeConfig({ 'editor.vimMode.enabled': true })
    const controller = createVimEditorController({
      editor: fake.editor,
      configService: config as never,
      contextKeyService: createContext() as never,
      statusBarService: createStatusBar() as never,
      inputMethodService: createInputMethodService() as never,
    })
    fake.focus()
    const input = await openSearchBox(fake, controller, '/')
    type(input, 'foo')
    fake.modelChange()
    expect(fake.overlays()[0]?.getDomNode().hidden).toBe(true)

    config.set('editor.vimMode.enabled', false)
    ;(config as unknown as { fire(key: string): void }).fire('editor.vimMode.enabled')
    controller.dispose()
    expect(fake.overlays()).toHaveLength(0)
  })
})
