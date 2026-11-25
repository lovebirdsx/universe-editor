/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { monaco } from '../../monaco/MonacoLoader.js'
import { createVimEditorController } from '../vimEditorController.js'
import { resetVimRegisterForTests, setVimRegister } from '../vimRegisters.js'
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

interface FakeFoldRegion {
  readonly startLineNumber: number
  readonly endLineNumber: number
  readonly isCollapsed: boolean
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
  const contentListeners: (() => void)[] = []
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
  const contributions = new Map<string, monaco.editor.IEditorContribution>()
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
    getTopForLineNumber: vi.fn((lineNumber: number) => (lineNumber - 1) * 20),
    getBottomForLineNumber: vi.fn((lineNumber: number) => lineNumber * 20),
    setScrollTop: vi.fn(),
    getLayoutInfo: vi.fn(() => ({ height: 30, lineHeight: 20 })),
    getContribution: <T extends monaco.editor.IEditorContribution>(id: string): T | null =>
      (contributions.get(id) as T | undefined) ?? null,
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
    onDidChangeModelContent: (listener) => {
      contentListeners.push(listener)
      return {
        dispose: () => {
          const index = contentListeners.indexOf(listener)
          if (index >= 0) contentListeners.splice(index, 1)
        },
      }
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
    contentChange: () => contentListeners.forEach((listener) => listener()),
    selection: () => selection,
    container,
    overlays: () => overlays,
    decorationSets: () => decorationSets,
    decorationClears: () => decorationClears,
    setContribution: (
      id: string,
      contribution: monaco.editor.IEditorContribution & {
        stickyScrollWidgetHeight?: number
        foldingModel?: {
          getAllRegionsAtLine(lineNumber: number): readonly FakeFoldRegion[]
        } | null
      },
    ) => {
      contributions.set(id, contribution)
    },
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

function createVimModeService() {
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
    activateSurface: () => undefined,
    getEffectiveKeymap: () => [],
    getUserKeymap: () => [],
    reservedKeys: [],
    getSequenceTimeoutMs: () => 800,
    getPassThroughUnmappedKeys: () => false,
    getLeader: () => 'space',
    getShowStatusBar: () => true,
    isSurfaceEnabled: () => true,
  }
}

function createInputMethodService() {
  return {
    switchToEnglish: vi.fn(async () => true),
    restore: vi.fn(async () => undefined),
  }
}

describe('createVimEditorController', () => {
  beforeEach(() => {
    resetVimSearchForTests()
    resetVimRegisterForTests()
  })

  function createNormalHarness(
    lines: string[],
    extra: Partial<Parameters<typeof createVimEditorController>[0]> = {},
  ) {
    const fake = createFakeEditor(lines)
    const vim = createVimModeService()
    const controller = createVimEditorController({
      editor: fake.editor,
      surfaceKey: 'editor:test',
      configService: createFakeConfig({ 'vim.enabled': true }) as never,
      contextKeyService: createContext() as never,
      vimModeService: vim as never,
      inputMethodService: createInputMethodService() as never,
      ...extra,
    })
    fake.focus()
    return { fake, vim, controller }
  }

  function fold(
    startLineNumber: number,
    endLineNumber: number,
    isCollapsed = true,
  ): FakeFoldRegion {
    return { startLineNumber, endLineNumber, isCollapsed }
  }

  function setFolding(
    fake: ReturnType<typeof createFakeEditor>,
    regions: readonly FakeFoldRegion[],
  ): void {
    fake.setContribution('editor.contrib.folding', {
      dispose: () => {},
      foldingModel: {
        getAllRegionsAtLine: (line) =>
          regions.filter(
            (region) => region.startLineNumber <= line && line <= region.endLineNumber,
          ),
      },
    })
  }

  function expectVisible(
    fake: ReturnType<typeof createFakeEditor>,
    regions: readonly FakeFoldRegion[],
  ): void {
    const line = fake.selection().startLineNumber
    expect(
      regions.some(
        (region) =>
          region.isCollapsed && line > region.startLineNumber && line <= region.endLineNumber,
      ),
    ).toBe(false)
  }

  it('does nothing while disabled', () => {
    const fake = createFakeEditor(['abc', 'def'])
    const controller = createVimEditorController({
      editor: fake.editor,
      surfaceKey: 'editor:test',
      configService: createFakeConfig({}) as never,
      contextKeyService: createContext() as never,
      vimModeService: createVimModeService() as never,
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
      surfaceKey: 'editor:test',
      configService: createFakeConfig({ 'vim.enabled': true }) as never,
      contextKeyService: createContext() as never,
      vimModeService: createVimModeService() as never,
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
      surfaceKey: 'editor:test',
      configService: createFakeConfig({ 'vim.enabled': true }) as never,
      contextKeyService: createContext() as never,
      vimModeService: createVimModeService() as never,
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
    const vim = createVimModeService()
    const controller = createVimEditorController({
      editor: fake.editor,
      surfaceKey: 'editor:test',
      configService: createFakeConfig({ 'vim.enabled': true }) as never,
      contextKeyService: context as never,
      vimModeService: vim as never,
      inputMethodService: createInputMethodService() as never,
    })
    fake.focus()
    controller.handleKeyDown(key('i'))
    expect(vim.modes.get('editor:test')).toBe('insert')
    // Insert mode lets printable keys through.
    expect(controller.handleKeyDown(key('j'))).toBe(false)
    controller.handleKeyDown(key('Escape'))
    expect(vim.modes.get('editor:test')).toBe('normal')
    controller.dispose()
  })

  it('dismisses the suggest widget when leaving Insert', () => {
    const { fake, controller } = createNormalHarness(['abc'])
    expect(controller.handleKeyDown(key('i'))).toBe(true)
    expect(fake.editor.trigger).not.toHaveBeenCalledWith('vim', 'hideSuggestWidget', null)

    expect(controller.handleKeyDown(key('Escape'))).toBe(true)
    expect(fake.editor.trigger).toHaveBeenCalledWith('vim', 'hideSuggestWidget', null)

    // Leaving Visual is not an Insert exit.
    vi.mocked(fake.editor.trigger).mockClear()
    expect(controller.handleKeyDown(key('v'))).toBe(true)
    expect(controller.handleKeyDown(key('Escape'))).toBe(true)
    expect(fake.editor.trigger).not.toHaveBeenCalledWith('vim', 'hideSuggestWidget', null)
    controller.dispose()
  })

  it('exposes the core pending prefix for which-key', () => {
    const { controller } = createNormalHarness(['abc'])
    expect(controller.getPendingHint()).toBeUndefined()

    controller.handleKeyDown(key('g'))
    expect(controller.getPendingHint()?.prefix).toBe('g')
    expect(controller.getPendingHint()?.items.length).toBeGreaterThan(10)

    controller.handleKeyDown(key('Escape'))
    expect(controller.getPendingHint()).toBeUndefined()

    controller.handleKeyDown(key('d'))
    expect(controller.getPendingHint()?.prefix).toBe('d')
    controller.handleKeyDown(key('i'))
    expect(controller.getPendingHint()?.prefix).toBe('di')

    controller.handleKeyDown(key('Escape'))
    controller.handleKeyDown(key('i'))
    expect(controller.getPendingHint()).toBeUndefined()

    controller.dispose()
    expect(controller.getPendingHint()).toBeUndefined()
  })

  it('keeps the mode across a focus move and restores it on return', () => {
    const fake = createFakeEditor(['abc'])
    const vim = createVimModeService()
    const controller = createVimEditorController({
      editor: fake.editor,
      surfaceKey: 'editor:1:a',
      configService: createFakeConfig({ 'vim.enabled': true }) as never,
      contextKeyService: createContext() as never,
      vimModeService: vim as never,
      inputMethodService: createInputMethodService() as never,
    })
    fake.focus()
    controller.handleKeyDown(key('i'))
    expect(vim.modes.get('editor:1:a')).toBe('insert')

    fake.blur()
    // Focus leaving is not a mode change: the surface remembers Insert.
    expect(vim.modes.get('editor:1:a')).toBe('insert')

    fake.focus()
    expect(vim.modes.get('editor:1:a')).toBe('insert')
    // The reducer still holds Insert, so typing passes through and Esc works.
    expect(controller.handleKeyDown(key('x'))).toBe(false)
    expect(controller.handleKeyDown(key('Escape'))).toBe(true)
    expect(vim.modes.get('editor:1:a')).toBe('normal')
    controller.dispose()
  })

  it('restores the mode of the surface the model switches to', () => {
    const fake = createFakeEditor(['abc'])
    const vim = createVimModeService()
    let surface = 'editor:1:a'
    vim.modes.set('editor:1:b', 'insert')
    const controller = createVimEditorController({
      editor: fake.editor,
      surfaceKey: () => surface,
      configService: createFakeConfig({ 'vim.enabled': true }) as never,
      contextKeyService: createContext() as never,
      vimModeService: vim as never,
      inputMethodService: createInputMethodService() as never,
    })
    fake.focus()
    expect(controller.handleKeyDown(key('j'))).toBe(true)

    surface = 'editor:1:b'
    fake.modelChange()
    // B was left in Insert: printable keys must reach the editor again.
    expect(controller.handleKeyDown(key('x'))).toBe(false)
    expect(controller.handleKeyDown(key('Escape'))).toBe(true)
    expect(vim.modes.get('editor:1:b')).toBe('normal')

    surface = 'editor:1:a'
    fake.modelChange()
    expect(controller.handleKeyDown(key('j'))).toBe(true)
    controller.dispose()
  })

  it('remembers modes per surface so two splits of one file stay independent', () => {
    const vim = createVimModeService()
    const first = createFakeEditor(['abc'])
    const second = createFakeEditor(['abc'])
    const options = {
      configService: createFakeConfig({ 'vim.enabled': true }) as never,
      contextKeyService: createContext() as never,
      vimModeService: vim as never,
      inputMethodService: createInputMethodService() as never,
    }
    const firstController = createVimEditorController({
      ...options,
      editor: first.editor,
      surfaceKey: 'editor:1:file:///ws/a.txt',
    })
    const secondController = createVimEditorController({
      ...options,
      editor: second.editor,
      surfaceKey: 'editor:2:file:///ws/a.txt',
    })

    first.focus()
    firstController.handleKeyDown(key('i'))
    expect(vim.modes.get('editor:1:file:///ws/a.txt')).toBe('insert')
    first.blur()

    second.focus()
    expect(secondController.handleKeyDown(key('j'))).toBe(true)
    expect(vim.modes.get('editor:2:file:///ws/a.txt')).toBe('normal')

    first.focus()
    expect(firstController.handleKeyDown(key('x'))).toBe(false)
    firstController.dispose()
    secondController.dispose()
  })

  it('enters Insert after the cursor with a, and after the line with A', () => {
    const fake = createFakeEditor(['abc', 'de'])
    const context = createContext()
    const vim = createVimModeService()
    const controller = createVimEditorController({
      editor: fake.editor,
      surfaceKey: 'editor:test',
      configService: createFakeConfig({ 'vim.enabled': true }) as never,
      contextKeyService: context as never,
      vimModeService: vim as never,
      inputMethodService: createInputMethodService() as never,
    })
    fake.focus()

    fake.editor.setPosition({ lineNumber: 1, column: 2 })
    controller.handleKeyDown(key('a'))
    expect(vim.modes.get('editor:test')).toBe('insert')
    expect(fake.selection()).toMatchObject({ startLineNumber: 1, startColumn: 3 })
    controller.handleKeyDown(key('Escape'))

    // `a` on the last character lands on the insert position after it.
    fake.editor.setPosition({ lineNumber: 2, column: 2 })
    controller.handleKeyDown(key('a'))
    expect(fake.selection()).toMatchObject({ startLineNumber: 2, startColumn: 3 })
    controller.handleKeyDown(key('Escape'))

    fake.editor.setPosition({ lineNumber: 2, column: 1 })
    controller.handleKeyDown(key('A'))
    expect(vim.modes.get('editor:test')).toBe('insert')
    expect(fake.selection()).toMatchObject({ startLineNumber: 2, startColumn: 3 })
    controller.dispose()
  })

  it('ignores IME composition strokes', () => {
    const fake = createFakeEditor(['abc'])
    const controller = createVimEditorController({
      editor: fake.editor,
      surfaceKey: 'editor:test',
      configService: createFakeConfig({ 'vim.enabled': true }) as never,
      contextKeyService: createContext() as never,
      vimModeService: createVimModeService() as never,
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
      surfaceKey: 'editor:test',
      configService: createFakeConfig({ 'vim.enabled': true }) as never,
      contextKeyService: createContext() as never,
      vimModeService: createVimModeService() as never,
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
      surfaceKey: 'editor:test',
      configService: createFakeConfig({ 'vim.enabled': true }) as never,
      contextKeyService: createContext() as never,
      vimModeService: createVimModeService() as never,
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
      surfaceKey: 'editor:test',
      configService: createFakeConfig({
        'vim.enabled': true,
        'vim.autoSwitchInputMethod': false,
      }) as never,
      contextKeyService: createContext() as never,
      vimModeService: createVimModeService() as never,
      inputMethodService: inputMethod as never,
    })
    fake.focus()
    await Promise.resolve()
    expect(inputMethod.switchToEnglish).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('keeps the native IME while an Insert surface is unfocused and refocused', async () => {
    const fake = createFakeEditor(['abc'])
    const inputMethod = createInputMethodService()
    const controller = createVimEditorController({
      editor: fake.editor,
      surfaceKey: 'editor:test',
      configService: createFakeConfig({ 'vim.enabled': true }) as never,
      contextKeyService: createContext() as never,
      vimModeService: createVimModeService() as never,
      inputMethodService: inputMethod as never,
    })
    fake.focus()
    await vi.waitFor(() => expect(inputMethod.switchToEnglish).toHaveBeenCalledTimes(1))

    controller.handleKeyDown(key('i'))
    await vi.waitFor(() => expect(inputMethod.restore).toHaveBeenCalledTimes(1))

    fake.blur()
    fake.focus()
    await Promise.resolve()
    // Entering Insert already restored the native IME; coming back in Insert
    // must not switch to English just because the editor regained text focus.
    expect(inputMethod.switchToEnglish).toHaveBeenCalledTimes(1)
    expect(inputMethod.restore).toHaveBeenCalledTimes(1)

    controller.handleKeyDown(key('Escape'))
    await vi.waitFor(() => expect(inputMethod.switchToEnglish).toHaveBeenCalledTimes(2))
    controller.dispose()
  })

  it('reports mode changes to the Vim mode service', () => {
    // Auxiliary windows portal their editor DOM into a separate document but
    // share the main renderer's Vim service.
    const auxDocument = document.implementation.createHTMLDocument('auxiliary')
    const fake = createFakeEditor(['abc'], auxDocument)
    const vim = createVimModeService()
    const controller = createVimEditorController({
      editor: fake.editor,
      surfaceKey: 'editor:test',
      configService: createFakeConfig({ 'vim.enabled': true }) as never,
      contextKeyService: createContext() as never,
      vimModeService: vim as never,
      inputMethodService: createInputMethodService() as never,
    })

    fake.focus()

    expect(vim.modes.get('editor:test')).toBe('normal')
    controller.handleKeyDown(key('i'))
    expect(vim.modes.get('editor:test')).toBe('insert')
    controller.dispose()
    auxDocument.body.removeChild(fake.container)
  })

  it('resets to Normal when the configuration is disabled', () => {
    const fake = createFakeEditor(['abc'])
    const config = createFakeConfig({ 'vim.enabled': true })
    const context = createContext()
    const vim = createVimModeService()
    const controller = createVimEditorController({
      editor: fake.editor,
      surfaceKey: 'editor:test',
      configService: config as never,
      contextKeyService: context as never,
      vimModeService: vim as never,
      inputMethodService: createInputMethodService() as never,
    })
    fake.focus()
    controller.handleKeyDown(key('i'))
    config.set('vim.enabled', false)
    ;(config as unknown as { fire(key: string): void }).fire('vim.enabled')
    expect(vim.modes.get('editor:test')).toBe('normal')
    expect(controller.handleKeyDown(key('j'))).toBe(false)
    controller.dispose()
  })

  it('yanks a deleted line so p pastes it back', () => {
    const fake = createFakeEditor(['one', 'two', 'three'])
    const controller = createVimEditorController({
      editor: fake.editor,
      surfaceKey: 'editor:test',
      configService: createFakeConfig({ 'vim.enabled': true }) as never,
      contextKeyService: createContext() as never,
      vimModeService: createVimModeService() as never,
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

  function createSearchHarness(lines: string[], config: Record<string, unknown> = {}) {
    const fake = createFakeEditor(lines)
    const context = createContext()
    const configService = createFakeConfig({
      'vim.enabled': true,
      ...config,
    })
    const controller = createVimEditorController({
      editor: fake.editor,
      surfaceKey: 'editor:test',
      configService: configService as never,
      contextKeyService: context as never,
      vimModeService: createVimModeService() as never,
      inputMethodService: createInputMethodService() as never,
    })
    fake.focus()
    return { fake, controller, context, config: configService }
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
      inlineClassName: 'vim-search-match-current',
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
    // The default (`highlightSearch` off) drops the transient preview highlight.
    expect(fake.decorationClears()).toBeGreaterThan(clears)
    expect(getLastVimSearch()).toEqual({
      text: 'foo',
      direction: 'forward',
      caseSensitive: false,
      wholeWord: false,
    })
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
    const config = createFakeConfig({ 'vim.enabled': true })
    const controller = createVimEditorController({
      editor: fake.editor,
      surfaceKey: 'editor:test',
      configService: config as never,
      contextKeyService: createContext() as never,
      vimModeService: createVimModeService() as never,
      inputMethodService: createInputMethodService() as never,
    })
    fake.focus()
    const input = await openSearchBox(fake, controller, '/')
    type(input, 'foo')
    fake.modelChange()
    expect(fake.overlays()[0]?.getDomNode().hidden).toBe(true)

    config.set('vim.enabled', false)
    ;(config as unknown as { fire(key: string): void }).fire('vim.enabled')
    controller.dispose()
    expect(fake.overlays()).toHaveLength(0)
  })

  it('exposes an Aa toggle that flips the case policy', async () => {
    const { fake, controller } = createSearchHarness(['Foo bar', 'FOO baz', 'foo qux'])
    const input = await openSearchBox(fake, controller, '/')
    const button = fake
      .overlays()[0]!
      .getDomNode()
      .querySelector('.vim-search-case') as HTMLButtonElement
    expect(button.getAttribute('aria-pressed')).toBe('false')

    type(input, 'foo')
    // Smartcase: a lowercase query ignores case; the cursor's own match is skipped.
    expect(fake.selection()).toMatchObject({ startLineNumber: 2, startColumn: 1 })

    button.click()
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(fake.selection()).toMatchObject({ startLineNumber: 3, startColumn: 1 })

    button.click()
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(fake.selection()).toMatchObject({ startLineNumber: 2, startColumn: 1 })
    controller.dispose()
  })

  it('rewrites an explicit marker when Aa is clicked', async () => {
    const { fake, controller } = createSearchHarness(['Foo', 'foo'])
    const input = await openSearchBox(fake, controller, '/')
    const button = fake
      .overlays()[0]!
      .getDomNode()
      .querySelector('.vim-search-case') as HTMLButtonElement

    type(input, 'foo\\C')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    button.click()
    expect(input.value).toBe('foo\\c')
    expect(button.getAttribute('aria-pressed')).toBe('false')
    controller.dispose()
  })

  it('keeps the input focused when the Aa button is pressed', async () => {
    const { fake, controller } = createSearchHarness(['foo'])
    await openSearchBox(fake, controller, '/')
    const button = fake
      .overlays()[0]!
      .getDomNode()
      .querySelector('.vim-search-case') as HTMLButtonElement
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    button.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    controller.dispose()
  })

  it('searches as soon as the IME composition ends', async () => {
    const { fake, controller } = createSearchHarness(['foo', 'foo'])
    const input = await openSearchBox(fake, controller, '/')

    input.dispatchEvent(new Event('compositionstart'))
    input.value = 'fo'
    const composing = new Event('input') as InputEvent
    Object.defineProperty(composing, 'isComposing', { value: true })
    input.dispatchEvent(composing)
    expect(fake.selection()).toMatchObject({ startLineNumber: 1, startColumn: 1 })

    input.value = 'foo'
    input.dispatchEvent(new Event('compositionend'))
    // Some IMEs keep isComposing=true on the final input; compositionend wins.
    const finalInput = new Event('input') as InputEvent
    Object.defineProperty(finalInput, 'isComposing', { value: true })
    input.dispatchEvent(finalInput)

    await vi.waitFor(() =>
      expect(fake.selection()).toMatchObject({ startLineNumber: 2, startColumn: 1 }),
    )
    controller.dispose()
  })

  it('honors \\c / \\C and highlights only the stripped pattern', async () => {
    const { fake, controller } = createSearchHarness(['Foo', 'FOO'])
    const input = await openSearchBox(fake, controller, '/')
    type(input, 'foo\\c')
    expect(fake.selection()).toMatchObject({ startLineNumber: 2, startColumn: 1 })
    expect(fake.decorationSets().at(-1)?.[0]?.range).toMatchObject({
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 4,
    })

    type(input, 'foo\\C')
    const node = fake.overlays()[0]!.getDomNode()
    expect(node.querySelector('.vim-search-hint')?.textContent).toContain('\\c')
    controller.dispose()
  })

  it('treats a marker-only query as an empty pattern', async () => {
    const { fake, controller } = createSearchHarness(['foo'])
    const input = await openSearchBox(fake, controller, '/')
    type(input, '\\c')
    const node = fake.overlays()[0]!.getDomNode()
    expect(node.querySelector('.vim-search-hint')?.textContent).toBeTruthy()
    expect(fake.selection()).toMatchObject({ startLineNumber: 1, startColumn: 1 })
    press(input, 'Enter')
    expect(node.hidden).toBe(false)
    expect(getLastVimSearch()).toBeNull()
    controller.dispose()
  })

  it('drops the preview highlight on Enter and n/N by default', async () => {
    const { fake, controller } = createSearchHarness(['foo', 'foo'])
    const input = await openSearchBox(fake, controller, '/')
    type(input, 'foo')
    const clearsBefore = fake.decorationClears()
    const setsBefore = fake.decorationSets().length

    press(input, 'Enter')
    expect(fake.decorationClears()).toBeGreaterThan(clearsBefore)
    expect(fake.decorationSets().length).toBe(setsBefore)

    controller.handleKeyDown(key('n'))
    expect(fake.decorationSets().length).toBe(setsBefore)
    expect(fake.decorationClears()).toBeGreaterThan(clearsBefore)
    controller.dispose()
  })

  it('highlights every match when highlightSearch is enabled', async () => {
    const { fake, controller } = createSearchHarness(['foo bar', 'foo baz'], {
      'vim.highlightSearch': true,
    })
    const input = await openSearchBox(fake, controller, '/')
    type(input, 'foo')
    press(input, 'Enter')
    const decorations = fake.decorationSets().at(-1) ?? []
    expect(decorations).toHaveLength(2)
    expect(
      decorations.map((item) => (item.options as { inlineClassName?: string }).inlineClassName),
    ).toEqual(['vim-search-match', 'vim-search-match-current'])
    controller.dispose()
  })

  it('refreshes hlsearch after edits', async () => {
    const { fake, controller } = createSearchHarness(['foo', 'foo'], {
      'vim.highlightSearch': true,
    })
    const input = await openSearchBox(fake, controller, '/')
    type(input, 'foo')
    press(input, 'Enter')
    const setsBefore = fake.decorationSets().length

    vi.useFakeTimers()
    try {
      fake.contentChange()
      vi.advanceTimersByTime(150)
      expect(fake.decorationSets().length).toBeGreaterThan(setsBefore)
    } finally {
      vi.useRealTimers()
    }
    controller.dispose()
  })

  it('clears hlsearch on Normal-mode Escape until the next n/N', async () => {
    const { fake, controller } = createSearchHarness(['foo', 'foo'], {
      'vim.highlightSearch': true,
    })
    const input = await openSearchBox(fake, controller, '/')
    type(input, 'foo')
    press(input, 'Enter')
    const setsBefore = fake.decorationSets().length
    const clearsBefore = fake.decorationClears()

    controller.handleKeyDown(key('Escape'))
    expect(fake.decorationClears()).toBeGreaterThan(clearsBefore)

    vi.useFakeTimers()
    try {
      fake.contentChange()
      vi.advanceTimersByTime(150)
      expect(fake.decorationSets().length).toBe(setsBefore)
    } finally {
      vi.useRealTimers()
    }

    controller.handleKeyDown(key('n'))
    expect(fake.decorationSets().length).toBeGreaterThan(setsBefore)
    controller.dispose()
  })

  it('turns hlsearch on and off through configuration', async () => {
    const { fake, controller, config } = createSearchHarness(['foo', 'foo'])
    const input = await openSearchBox(fake, controller, '/')
    type(input, 'foo')
    press(input, 'Enter')
    const setsBefore = fake.decorationSets().length

    config.set('vim.highlightSearch', true)
    config.fire('vim.highlightSearch')
    expect(fake.decorationSets().length).toBeGreaterThan(setsBefore)

    const clearsBefore = fake.decorationClears()
    config.set('vim.highlightSearch', false)
    config.fire('vim.highlightSearch')
    expect(fake.decorationClears()).toBeGreaterThan(clearsBefore)
    controller.dispose()
  })

  it('replays the committed case policy for n/N', async () => {
    const { fake, controller } = createSearchHarness(['Foo', 'FOO', 'foo'])
    const input = await openSearchBox(fake, controller, '/')
    type(input, 'FOO')
    // Smartcase keeps this case-sensitive, so only line 2 matches.
    press(input, 'Enter')
    expect(fake.selection()).toMatchObject({ startLineNumber: 2, startColumn: 1 })
    controller.handleKeyDown(key('n'))
    expect(fake.selection()).toMatchObject({ startLineNumber: 2, startColumn: 1 })
    controller.dispose()
  })

  it('honors vim.searchCaseSensitivity defaults', async () => {
    const { fake, controller } = createSearchHarness(['Foo', 'foo'], {
      'vim.searchCaseSensitivity': 'insensitive',
    })
    const input = await openSearchBox(fake, controller, '/')
    type(input, 'foo')
    expect(fake.selection()).toMatchObject({ startLineNumber: 2, startColumn: 1 })
    press(input, 'Enter')
    controller.handleKeyDown(key('n'))
    expect(fake.selection()).toMatchObject({ startLineNumber: 1, startColumn: 1 })
    controller.dispose()
  })

  it('stops refreshing hlsearch once Vim is disabled', async () => {
    const { fake, controller, config } = createSearchHarness(['foo', 'foo'], {
      'vim.highlightSearch': true,
    })
    const input = await openSearchBox(fake, controller, '/')
    type(input, 'foo')
    press(input, 'Enter')
    const setsBefore = fake.decorationSets().length

    config.set('vim.enabled', false)
    config.fire('vim.enabled')

    vi.useFakeTimers()
    try {
      fake.contentChange()
      fake.modelChange()
      vi.advanceTimersByTime(200)
      expect(fake.decorationSets().length).toBe(setsBefore)
    } finally {
      vi.useRealTimers()
    }
    controller.dispose()
  })

  it('keeps the preview match highlighted when the scan skips an overlong line', async () => {
    const longLine = `${'a'.repeat(20001)}foo`
    const { fake, controller } = createSearchHarness([longLine], {
      'vim.highlightSearch': true,
    })
    const input = await openSearchBox(fake, controller, '/')
    type(input, 'foo')

    expect(fake.selection()).toMatchObject({ startLineNumber: 1, startColumn: 20002 })
    const decorations = fake.decorationSets().at(-1) ?? []
    expect(decorations).toHaveLength(1)
    expect(decorations[0]?.options).toMatchObject({
      inlineClassName: 'vim-search-match-current',
    })
    controller.dispose()
  })

  it('restores stored hlsearch when opening and cancelling a search', async () => {
    const { fake, controller } = createSearchHarness(['foo', 'foo'], {
      'vim.highlightSearch': true,
    })
    const input = await openSearchBox(fake, controller, '/')
    type(input, 'foo')
    press(input, 'Enter')

    const beforeOpen = fake.decorationSets().length
    await openSearchBox(fake, controller, '/')
    expect(fake.decorationSets().length).toBeGreaterThan(beforeOpen)
    expect(fake.decorationSets().at(-1)).toHaveLength(2)

    const beforeCancel = fake.decorationSets().length
    press(input, 'Escape')
    expect(fake.decorationSets().length).toBeGreaterThan(beforeCancel)
    expect(fake.decorationSets().at(-1)).toHaveLength(2)
    controller.dispose()
  })

  it('re-previews when the default case policy changes while the box is open', async () => {
    const { fake, controller, config } = createSearchHarness(['foo', 'Foo'])
    const input = await openSearchBox(fake, controller, '/')
    type(input, 'foo')
    // Smartcase with a lowercase query skips the match under the cursor and
    // lands on line 2.
    expect(fake.selection()).toMatchObject({ startLineNumber: 2, startColumn: 1 })

    config.set('vim.searchCaseSensitivity', 'sensitive')
    config.fire('vim.searchCaseSensitivity')
    expect(fake.selection()).toMatchObject({ startLineNumber: 1, startColumn: 1 })
    expect(fake.overlays()[0]!.getDomNode().querySelector('.vim-search-hint')?.textContent).toBe('')
    controller.dispose()
  })

  it('lets the IME consume Enter / Escape before committing or cancelling', async () => {
    const { fake, controller } = createSearchHarness(['foo'])
    const input = await openSearchBox(fake, controller, '/')
    type(input, 'foo')
    const node = fake.overlays()[0]!.getDomNode()

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    Object.defineProperty(enter, 'keyCode', { value: 229 })
    input.dispatchEvent(enter)
    expect(node.hidden).toBe(false)
    expect(getLastVimSearch()).toBeNull()

    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    Object.defineProperty(escape, 'isComposing', { value: true })
    input.dispatchEvent(escape)
    expect(node.hidden).toBe(false)
    expect(node.querySelector<HTMLInputElement>('input')?.value).toBe('foo')
    controller.dispose()
  })

  it('runs code-navigation editor commands from the g prefix', () => {
    const { fake, controller } = createNormalHarness(['const value = 1'])
    const mappings = [
      [['g', 'd'], 'editor.action.revealDefinition'],
      [['g', 'D'], 'editor.action.revealDeclaration'],
      [['g', 'y'], 'editor.action.goToTypeDefinition'],
      [['g', 'i'], 'editor.action.goToImplementation'],
      [['g', 'r'], 'editor.action.goToReferences'],
      [['g', 'R'], 'editor.action.referenceSearch.trigger'],
      [['g', 'h'], 'editor.action.showHover'],
    ] as const
    for (const [keys, commandId] of mappings) {
      for (const stroke of keys) controller.handleKeyDown(key(stroke))
      expect(fake.editor.trigger).toHaveBeenLastCalledWith('vim', commandId, null)
    }
    controller.dispose()
  })

  it('runs hover, bracket, marker and change navigation', () => {
    const executeCommand = vi.fn()
    const { fake, controller } = createNormalHarness(['(a)'], { executeCommand })
    controller.handleKeyDown(key('K'))
    expect(fake.editor.trigger).toHaveBeenLastCalledWith('vim', 'editor.action.showHover', null)
    controller.handleKeyDown(key('%'))
    expect(fake.selection().startColumn).toBe(3)
    controller.handleKeyDown(key(']'))
    controller.handleKeyDown(key('d'))
    expect(fake.editor.trigger).toHaveBeenLastCalledWith(
      'vim',
      'editor.action.marker.nextInFiles',
      null,
    )
    controller.handleKeyDown(key('['))
    controller.handleKeyDown(key('c'))
    expect(executeCommand).toHaveBeenLastCalledWith('workbench.action.editor.previousChange')
    controller.dispose()
  })

  it('opens a new line with o/O and enters Insert', () => {
    const { fake, vim, controller } = createNormalHarness(['abc'])
    controller.handleKeyDown(key('o'))
    expect(fake.editor.trigger).toHaveBeenLastCalledWith(
      'vim',
      'editor.action.insertLineAfter',
      null,
    )
    expect(vim.modes.get('editor:test')).toBe('insert')
    controller.handleKeyDown(key('Escape'))
    controller.handleKeyDown(key('O'))
    expect(fake.editor.trigger).toHaveBeenLastCalledWith(
      'vim',
      'editor.action.insertLineBefore',
      null,
    )
    expect(vim.modes.get('editor:test')).toBe('insert')
    controller.dispose()
  })

  it('indents and outdents the counted lines with one command for >> and <<', () => {
    const { fake, controller } = createNormalHarness(['abc', 'def', 'ghi'])
    controller.handleKeyDown(key('2'))
    controller.handleKeyDown(key('>'))
    controller.handleKeyDown(key('>'))
    expect(fake.editor.setSelections).toHaveBeenLastCalledWith(
      [
        {
          selectionStartLineNumber: 1,
          selectionStartColumn: 1,
          positionLineNumber: 2,
          positionColumn: 4,
        },
      ],
      'vim',
    )
    expect(fake.editor.trigger).toHaveBeenCalledTimes(1)
    expect(fake.editor.trigger).toHaveBeenNthCalledWith(1, 'vim', 'editor.action.indentLines', null)
    controller.handleKeyDown(key('<'))
    controller.handleKeyDown(key('<'))
    expect(fake.editor.trigger).toHaveBeenLastCalledWith('vim', 'editor.action.outdentLines', null)
    controller.dispose()
  })

  it('searches the word under the cursor with * and #', () => {
    const { fake, controller } = createNormalHarness(['foo fooBar foo'])
    controller.handleKeyDown(key('*'))
    // `fooBar` is a different word: `*` skips its `foo` and lands on the
    // standalone match.
    expect(fake.selection()).toMatchObject({ startLineNumber: 1, startColumn: 12 })
    expect(getLastVimSearch()).toMatchObject({
      text: 'foo',
      direction: 'forward',
      wholeWord: true,
    })
    controller.handleKeyDown(key('n'))
    expect(fake.selection()).toMatchObject({ startLineNumber: 1, startColumn: 1 })
    controller.handleKeyDown(key('#'))
    expect(fake.selection()).toMatchObject({ startLineNumber: 1, startColumn: 12 })
    controller.dispose()
  })

  it('keeps / searches literal inside words', async () => {
    const { fake, controller } = createNormalHarness(['x fooBar'])
    const input = await openSearchBox(fake, controller, '/')
    type(input, 'foo')
    press(input, 'Enter')
    expect(fake.selection()).toMatchObject({ startLineNumber: 1, startColumn: 3 })
    expect(getLastVimSearch()).toMatchObject({ text: 'foo', wholeWord: false })
    controller.dispose()
  })

  it('scrolls the viewport with Ctrl+e / Ctrl+y and counts', () => {
    const { fake, controller } = createNormalHarness(['one', 'two'])
    vi.mocked(fake.editor.trigger).mockClear()

    controller.handleKeyDown(key('e', { ctrlKey: true }))
    expect(fake.editor.trigger).toHaveBeenLastCalledWith('vim', 'editorScroll', {
      to: 'down',
      by: 'wrappedLine',
      value: 1,
      revealCursor: true,
      select: false,
    })

    controller.handleKeyDown(key('3'))
    controller.handleKeyDown(key('y', { ctrlKey: true }))
    expect(fake.editor.trigger).toHaveBeenLastCalledWith('vim', 'editorScroll', {
      to: 'up',
      by: 'wrappedLine',
      value: 3,
      revealCursor: true,
      select: false,
    })
    controller.dispose()
  })

  it('centers / tops / bottoms a line with zz/zt/zb and moves the cursor for a count', () => {
    const { fake, controller } = createNormalHarness(['one', 'two', 'three'])
    controller.handleKeyDown(key('j'))
    vi.mocked(fake.editor.setPosition).mockClear()
    vi.mocked(fake.editor.trigger).mockClear()
    vi.mocked(fake.editor.setScrollTop).mockClear()

    controller.handleKeyDown(key('z'))
    controller.handleKeyDown(key('z'))
    expect(fake.editor.trigger).toHaveBeenLastCalledWith('vim', 'revealLine', {
      lineNumber: 1,
      at: 'center',
    })

    // Top/bottom bypass Monaco's revealLine padding (sticky scroll reserves
    // five lines by default) and set the scroll offset for an edge-flush line.
    controller.handleKeyDown(key('z'))
    controller.handleKeyDown(key('t'))
    expect(fake.editor.setScrollTop).toHaveBeenLastCalledWith(20)

    controller.handleKeyDown(key('z'))
    controller.handleKeyDown(key('b'))
    expect(fake.editor.setScrollTop).toHaveBeenLastCalledWith(10)
    // No count: the cursor line is the target, so it stays put.
    expect(fake.editor.setPosition).not.toHaveBeenCalled()

    // A count is the target line number: 3zt puts line 3 at the top and moves
    // the cursor there (Vim keeps the column).
    fake.editor.setPosition({ lineNumber: 2, column: 3 }, 'vim')
    vi.mocked(fake.editor.setPosition).mockClear()
    controller.handleKeyDown(key('3'))
    controller.handleKeyDown(key('z'))
    controller.handleKeyDown(key('t'))
    expect(fake.editor.setScrollTop).toHaveBeenLastCalledWith(40)
    expect(fake.editor.setPosition).toHaveBeenLastCalledWith({ lineNumber: 3, column: 3 }, 'vim')
    expect(fake.selection()).toMatchObject({ startLineNumber: 3, startColumn: 3 })
    controller.dispose()
  })

  it('keeps zt below the sticky-scroll overlay', () => {
    const { fake, controller } = createNormalHarness(['one', 'two', 'three'])
    fake.setContribution('store.contrib.stickyScrollController', {
      dispose: () => {},
      stickyScrollWidgetHeight: 10,
    })
    controller.handleKeyDown(key('3'))
    controller.handleKeyDown(key('z'))
    controller.handleKeyDown(key('t'))
    // topForLine(3) = 40, minus the 10px sticky overlay.
    expect(fake.editor.setScrollTop).toHaveBeenLastCalledWith(30)
    controller.dispose()
  })

  it('jumps to the top/middle/bottom visible line with H/M/L and counts', () => {
    const lines = Array.from({ length: 50 }, (_, index) => `line${index + 1}`)
    const { fake, controller } = createNormalHarness(lines)
    fake.editor.getVisibleRanges = () => [
      { startLineNumber: 10, startColumn: 1, endLineNumber: 30, endColumn: 1 },
    ]
    vi.mocked(fake.editor.revealPositionInCenterIfOutsideViewport).mockClear()

    controller.handleKeyDown(key('H'))
    expect(fake.selection()).toMatchObject({ startLineNumber: 10, startColumn: 1 })
    controller.handleKeyDown(key('M'))
    expect(fake.selection()).toMatchObject({ startLineNumber: 20, startColumn: 1 })
    controller.handleKeyDown(key('L'))
    expect(fake.selection()).toMatchObject({ startLineNumber: 30, startColumn: 1 })

    controller.handleKeyDown(key('2'))
    controller.handleKeyDown(key('H'))
    expect(fake.selection()).toMatchObject({ startLineNumber: 11 })
    controller.handleKeyDown(key('2'))
    controller.handleKeyDown(key('M'))
    // Vim's M ignores a count.
    expect(fake.selection()).toMatchObject({ startLineNumber: 20 })
    controller.handleKeyDown(key('2'))
    controller.handleKeyDown(key('L'))
    expect(fake.selection()).toMatchObject({ startLineNumber: 29 })

    expect(fake.editor.revealPositionInCenterIfOutsideViewport).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('keeps H/M/L inside visible ranges when folds split the viewport', () => {
    const lines = Array.from({ length: 100 }, (_, index) => `line${index + 1}`)
    const { fake, controller } = createNormalHarness(lines)
    fake.editor.getVisibleRanges = () => [
      { startLineNumber: 10, startColumn: 1, endLineNumber: 19, endColumn: 1 },
      { startLineNumber: 61, startColumn: 1, endLineNumber: 80, endColumn: 1 },
    ]

    controller.handleKeyDown(key('H'))
    expect(fake.selection()).toMatchObject({ startLineNumber: 10 })
    controller.handleKeyDown(key('M'))
    // 30 visible lines; the 16th is the first line of the second range + 5.
    expect(fake.selection()).toMatchObject({ startLineNumber: 66 })
    controller.handleKeyDown(key('L'))
    expect(fake.selection()).toMatchObject({ startLineNumber: 80 })
    controller.dispose()
  })

  it('skips sticky-scroll rows for H and M', () => {
    const lines = Array.from({ length: 50 }, (_, index) => `line${index + 1}`)
    const { fake, controller } = createNormalHarness(lines)
    fake.editor.getVisibleRanges = () => [
      { startLineNumber: 10, startColumn: 1, endLineNumber: 30, endColumn: 1 },
    ]
    // 10px at a 20px line height covers the first visible row.
    fake.setContribution('store.contrib.stickyScrollController', {
      dispose: () => {},
      stickyScrollWidgetHeight: 10,
    })

    controller.handleKeyDown(key('H'))
    expect(fake.selection()).toMatchObject({ startLineNumber: 11 })
    controller.handleKeyDown(key('M'))
    expect(fake.selection()).toMatchObject({ startLineNumber: 21 })
    controller.handleKeyDown(key('L'))
    expect(fake.selection()).toMatchObject({ startLineNumber: 30 })
    controller.dispose()
  })

  it('drops a pending z on blur', () => {
    const { fake, controller } = createNormalHarness(['one', 'two'])
    controller.handleKeyDown(key('z'))
    fake.blur()
    fake.focus()
    vi.mocked(fake.editor.trigger).mockClear()

    controller.handleKeyDown(key('t'))
    expect(fake.editor.trigger).not.toHaveBeenCalled()
    controller.dispose()
  })

  describe('folding-aware motions', () => {
    const lines = (count: number): string[] =>
      Array.from({ length: count }, (_, index) => `word${index + 1}`)

    function setCursor(fake: ReturnType<typeof createFakeEditor>, line: number, column = 1): void {
      fake.editor.setPosition({ lineNumber: line, column }, 'vim')
    }

    it('treats a closed fold as one screen row for j/k', () => {
      const regions = [fold(10, 20)]
      const { fake, controller } = createNormalHarness(lines(30))
      setFolding(fake, regions)
      setCursor(fake, 9)

      controller.handleKeyDown(key('j'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 10 })
      expectVisible(fake, regions)

      controller.handleKeyDown(key('j'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 21 })
      expectVisible(fake, regions)

      controller.handleKeyDown(key('k'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 10 })
      controller.handleKeyDown(key('k'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 9 })
      expectVisible(fake, regions)
      controller.dispose()
    })

    it('counts screen rows rather than model lines', () => {
      const regions = [fold(2, 10)]
      const { fake, controller } = createNormalHarness(lines(30))
      setFolding(fake, regions)
      setCursor(fake, 1)

      controller.handleKeyDown(key('4'))
      controller.handleKeyDown(key('j'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 13 })
      expectVisible(fake, regions)

      setCursor(fake, 11)
      controller.handleKeyDown(key('2'))
      controller.handleKeyDown(key('k'))
      // 11 -> fold start 2 (one screen row) -> 1.
      expect(fake.selection()).toMatchObject({ startLineNumber: 1 })
      expectVisible(fake, regions)
      controller.dispose()
    })

    it('stops on the fold start when the fold reaches EOF', () => {
      const regions = [fold(10, 20)]
      const { fake, controller } = createNormalHarness(lines(20))
      setFolding(fake, regions)

      setCursor(fake, 10)
      controller.handleKeyDown(key('j'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 10 })

      setCursor(fake, 9)
      controller.handleKeyDown(key('j'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 10 })

      setCursor(fake, 10)
      controller.handleKeyDown(key('k'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 9 })
      expectVisible(fake, regions)
      controller.dispose()
    })

    it('uses the outermost collapsed fold for nested ranges', () => {
      const regions = [fold(5, 25), fold(10, 15)]
      const { fake, controller } = createNormalHarness(lines(30))
      setFolding(fake, regions)
      setCursor(fake, 4)

      controller.handleKeyDown(key('j'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 5 })
      controller.handleKeyDown(key('j'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 26 })
      controller.handleKeyDown(key('k'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 5 })
      expectVisible(fake, regions)
      controller.dispose()
    })

    it('ignores expanded folds', () => {
      const regions = [fold(10, 20, false)]
      const { fake, controller } = createNormalHarness(lines(30))
      setFolding(fake, regions)
      setCursor(fake, 9)

      controller.handleKeyDown(key('j'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 10 })
      controller.handleKeyDown(key('j'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 11 })
      controller.dispose()
    })

    it('moves Enter onto the first non-blank screen row after a fold', () => {
      const regions = [fold(2, 3)]
      const { fake, controller } = createNormalHarness(['top', '  hidden1', '  hidden2', '  end'])
      setFolding(fake, regions)
      setCursor(fake, 2)

      controller.handleKeyDown(key('Enter'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 4, startColumn: 3 })

      controller.handleKeyDown(key('Enter'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 4, startColumn: 3 })
      controller.dispose()
    })

    it('counts page motions by visible screen rows', () => {
      const regions = [fold(20, 60)]
      const { fake, controller } = createNormalHarness(lines(100))
      setFolding(fake, regions)
      fake.editor.getVisibleRanges = () => [
        { startLineNumber: 10, startColumn: 1, endLineNumber: 20, endColumn: 1 },
        { startLineNumber: 61, startColumn: 1, endLineNumber: 80, endColumn: 1 },
      ]

      setCursor(fake, 10)
      controller.handleKeyDown(key('PageDown'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 81 })
      expectVisible(fake, regions)

      controller.handleKeyDown(key('PageUp'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 10 })
      expectVisible(fake, regions)

      setCursor(fake, 10)
      controller.handleKeyDown(key('d', { ctrlKey: true }))
      expect(fake.selection()).toMatchObject({ startLineNumber: 65 })
      expectVisible(fake, regions)

      controller.handleKeyDown(key('u', { ctrlKey: true }))
      expect(fake.selection()).toMatchObject({ startLineNumber: 10 })
      expectVisible(fake, regions)
      controller.dispose()
    })

    it('snaps word motions that land in a closed fold', () => {
      const regions = [fold(10, 20)]
      const { fake, controller } = createNormalHarness(lines(30))
      setFolding(fake, regions)
      setCursor(fake, 10)

      controller.handleKeyDown(key('w'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 21 })
      expectVisible(fake, regions)

      controller.handleKeyDown(key('b'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 10 })
      expectVisible(fake, regions)

      setCursor(fake, 9)
      controller.handleKeyDown(key('w'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 10 })
      expectVisible(fake, regions)
      controller.dispose()
    })

    it('snaps paragraph motions to the fold start', () => {
      const regions = [fold(10, 20)]
      const body = lines(30)
      body[14] = ''
      const { fake, controller } = createNormalHarness(body)
      setFolding(fake, regions)

      setCursor(fake, 1)
      controller.handleKeyDown(key('}'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 10, startColumn: 1 })
      expectVisible(fake, regions)

      controller.handleKeyDown(key('}'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 21, startColumn: 1 })
      expectVisible(fake, regions)

      setCursor(fake, 25)
      controller.handleKeyDown(key('{'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 10, startColumn: 1 })
      expectVisible(fake, regions)
      controller.dispose()
    })

    it('snaps gg/G targets and keeps their first non-blank column', () => {
      const regions = [fold(10, 20)]
      const body = lines(30)
      body[9] = '  fold-start'
      const { fake, controller } = createNormalHarness(body)
      setFolding(fake, regions)

      setCursor(fake, 1)
      controller.handleKeyDown(key('1'))
      controller.handleKeyDown(key('5'))
      controller.handleKeyDown(key('G'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 10, startColumn: 3 })
      expectVisible(fake, regions)

      setCursor(fake, 21)
      controller.handleKeyDown(key('1'))
      controller.handleKeyDown(key('5'))
      controller.handleKeyDown(key('G'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 10, startColumn: 3 })
      expectVisible(fake, regions)

      setCursor(fake, 1)
      controller.handleKeyDown(key('2'))
      controller.handleKeyDown(key('5'))
      controller.handleKeyDown(key('G'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 25 })
      controller.dispose()
    })

    it('normalizes a hidden starting line before moving', () => {
      const regions = [fold(10, 20)]
      const { fake, controller } = createNormalHarness(lines(30))
      setFolding(fake, regions)
      setCursor(fake, 15)

      controller.handleKeyDown(key('j'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 21 })
      expectVisible(fake, regions)

      setCursor(fake, 15)
      controller.handleKeyDown(key('k'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 9 })
      expectVisible(fake, regions)
      controller.dispose()
    })

    it('snaps zt/zz/zb targets to the fold start', () => {
      const regions = [fold(10, 20)]
      const { fake, controller } = createNormalHarness(lines(30))
      setFolding(fake, regions)
      setCursor(fake, 1)

      controller.handleKeyDown(key('1'))
      controller.handleKeyDown(key('5'))
      controller.handleKeyDown(key('z'))
      controller.handleKeyDown(key('t'))
      expect(fake.editor.setScrollTop).toHaveBeenLastCalledWith(180)
      expect(fake.selection()).toMatchObject({ startLineNumber: 10, startColumn: 1 })

      setCursor(fake, 1)
      controller.handleKeyDown(key('1'))
      controller.handleKeyDown(key('5'))
      controller.handleKeyDown(key('z'))
      controller.handleKeyDown(key('z'))
      expect(fake.editor.trigger).toHaveBeenLastCalledWith('vim', 'revealLine', {
        lineNumber: 9,
        at: 'center',
      })

      setCursor(fake, 1)
      controller.handleKeyDown(key('1'))
      controller.handleKeyDown(key('5'))
      controller.handleKeyDown(key('z'))
      controller.handleKeyDown(key('b'))
      expect(fake.editor.setScrollTop).toHaveBeenLastCalledWith(170)
      expect(fake.selection()).toMatchObject({ startLineNumber: 10 })
      expectVisible(fake, regions)
      controller.dispose()
    })

    it('jumps [z to the current/ancestor fold start with first non-blank column', () => {
      const body = lines(30)
      body[9] = '  fold-start'
      body[4] = '    parent-start'
      const regions = [fold(10, 20, false), fold(5, 25, false)]
      const { fake, controller } = createNormalHarness(body)
      setFolding(fake, regions)

      setCursor(fake, 15)
      controller.handleKeyDown(key('['))
      controller.handleKeyDown(key('z'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 10, startColumn: 3 })

      setCursor(fake, 10)
      controller.handleKeyDown(key('['))
      controller.handleKeyDown(key('z'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 5, startColumn: 5 })

      controller.dispose()
    })

    it('jumps ]z to the current/ancestor fold end with first non-blank column', () => {
      const body = lines(30)
      body[19] = '  fold-end'
      body[24] = '    parent-end'
      const regions = [fold(10, 20, false), fold(5, 25, false)]
      const { fake, controller } = createNormalHarness(body)
      setFolding(fake, regions)

      setCursor(fake, 15)
      controller.handleKeyDown(key(']'))
      controller.handleKeyDown(key('z'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 20, startColumn: 3 })

      setCursor(fake, 20)
      controller.handleKeyDown(key(']'))
      controller.handleKeyDown(key('z'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 25, startColumn: 5 })

      controller.dispose()
    })

    it('ignores closed folds for [z / ]z', () => {
      const regions = [fold(10, 20, true)]
      const { fake, controller } = createNormalHarness(lines(30))
      setFolding(fake, regions)
      setCursor(fake, 10)

      controller.handleKeyDown(key('['))
      controller.handleKeyDown(key('z'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 10, startColumn: 1 })

      controller.handleKeyDown(key(']'))
      controller.handleKeyDown(key('z'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 10, startColumn: 1 })

      controller.dispose()
    })

    it('does nothing for [z / ]z when the cursor is outside any fold', () => {
      const { fake, controller } = createNormalHarness(lines(30))
      setFolding(fake, [fold(10, 20, false)])
      setCursor(fake, 1)

      controller.handleKeyDown(key('['))
      controller.handleKeyDown(key('z'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 1, startColumn: 1 })

      controller.handleKeyDown(key(']'))
      controller.handleKeyDown(key('z'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 1, startColumn: 1 })

      controller.dispose()
    })

    it('maps z fold commands to Monaco editor actions', () => {
      const { fake, controller } = createNormalHarness(lines(30))
      setFolding(fake, [fold(10, 20, false)])
      setCursor(fake, 15)

      const expected: ReadonlyArray<readonly [string, string]> = [
        ['o', 'editor.unfold'],
        ['O', 'editor.unfoldRecursively'],
        ['c', 'editor.fold'],
        ['C', 'editor.foldRecursively'],
        ['a', 'editor.toggleFold'],
        ['A', 'editor.toggleFoldRecursively'],
        ['M', 'editor.foldAll'],
        ['R', 'editor.unfoldAll'],
        ['j', 'editor.gotoNextFold'],
        ['k', 'editor.gotoPreviousFold'],
      ]
      for (const [foldKey, commandId] of expected) {
        vi.mocked(fake.editor.trigger).mockClear()
        controller.handleKeyDown(key('z'))
        controller.handleKeyDown(key(foldKey))
        expect(fake.editor.trigger).toHaveBeenLastCalledWith('vim', commandId, null)
      }

      controller.dispose()
    })
  })

  describe('Insert exit, Ctrl+[ and idle Escape', () => {
    const move = (fake: ReturnType<typeof createFakeEditor>, line: number, column: number) =>
      fake.editor.setPosition({ lineNumber: line, column }, 'test')

    it('steps the cursor back one column on Escape from Insert, never past column 1', () => {
      const { fake, controller } = createNormalHarness(['abcdef'])
      controller.handleKeyDown(key('i'))
      move(fake, 1, 4)
      controller.handleKeyDown(key('Escape'))
      expect(fake.selection().startColumn).toBe(3)

      controller.handleKeyDown(key('i'))
      move(fake, 1, 1)
      controller.handleKeyDown(key('Escape'))
      expect(fake.selection().startColumn).toBe(1)
      controller.dispose()
    })

    it('closes one undo group per Insert session', () => {
      const { fake, controller } = createNormalHarness(['abc'])
      controller.handleKeyDown(key('i'))
      vi.mocked(fake.editor.pushUndoStop).mockClear()
      controller.handleKeyDown(key('Escape'))
      expect(fake.editor.pushUndoStop).toHaveBeenCalledTimes(1)
      controller.dispose()
    })

    it('keeps cw and the text typed after it in one undo group', () => {
      const { fake, controller } = createNormalHarness(['foo bar'])
      const calls: string[] = []
      vi.mocked(fake.editor.pushUndoStop).mockImplementation(() => {
        calls.push('stop')
        return true
      })
      vi.mocked(fake.editor.executeEdits).mockImplementation(() => {
        calls.push('edit')
        return true
      })
      controller.handleKeyDown(key('c'))
      controller.handleKeyDown(key('w'))
      // Opening stop and the edit, no closing stop: typing joins the group.
      expect(calls).toEqual(['stop', 'edit'])
      controller.handleKeyDown(key('Escape'))
      expect(calls).toEqual(['stop', 'edit', 'stop'])
      controller.dispose()
    })

    it('treats Ctrl+[ exactly like Escape in Insert mode', () => {
      const { fake, vim, controller } = createNormalHarness(['abcdef'])
      controller.handleKeyDown(key('i'))
      move(fake, 1, 4)
      const event = key('[', { ctrlKey: true })
      expect(controller.handleKeyDown(event)).toBe(true)
      expect(event.defaultPrevented).toBe(true)
      expect(fake.selection().startColumn).toBe(3)
      expect(vim.modes.get('editor:test')).toBe('normal')
      controller.dispose()
    })

    it('focuses the editor tab strip on an Escape with nothing to clear', () => {
      const executeCommand = vi.fn()
      const { controller } = createNormalHarness(['abc'], { executeCommand })
      controller.handleKeyDown(key('Escape'))
      expect(executeCommand).toHaveBeenCalledTimes(1)
      expect(executeCommand).toHaveBeenCalledWith('workbench.action.focusEditorTabs')
      controller.dispose()
    })

    it('does not leave the editor when Escape cancels a pending prefix', () => {
      const executeCommand = vi.fn()
      const { controller } = createNormalHarness(['abc'], { executeCommand })
      controller.handleKeyDown(key('d'))
      controller.handleKeyDown(key('Escape'))
      controller.handleKeyDown(key('2'))
      controller.handleKeyDown(key('Escape'))
      expect(executeCommand).not.toHaveBeenCalled()
      controller.dispose()
    })

    it('clears hlsearch highlights first and only then hands focus away', async () => {
      const executeCommand = vi.fn()
      const config = createFakeConfig({ 'vim.enabled': true, 'vim.highlightSearch': true })
      const fake = createFakeEditor(['foo foo'])
      const controller = createVimEditorController({
        editor: fake.editor,
        surfaceKey: 'editor:test',
        configService: config as never,
        contextKeyService: createContext() as never,
        vimModeService: createVimModeService() as never,
        inputMethodService: createInputMethodService() as never,
        executeCommand,
      })
      fake.focus()
      controller.handleKeyDown(key('*'))
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(fake.decorationSets().length).toBeGreaterThan(0)
      controller.handleKeyDown(key('Escape'))
      expect(executeCommand).not.toHaveBeenCalled()
      controller.handleKeyDown(key('Escape'))
      expect(executeCommand).toHaveBeenCalledWith('workbench.action.focusEditorTabs')
      controller.dispose()
    })
  })

  describe('counts and word operators through the controller', () => {
    it('deletes six words for 2d3w (counts multiply)', () => {
      const { fake, controller } = createNormalHarness(['a b c d e f g h'])
      for (const k of ['2', 'd', '3', 'w']) controller.handleKeyDown(key(k))
      expect(fake.editor.executeEdits).toHaveBeenCalledWith('vim', [
        {
          range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 13 },
          text: '',
        },
      ])
      controller.dispose()
    })

    it('changes only the rest of the word for cw on a non-blank', () => {
      const { fake, vim, controller } = createNormalHarness(['foo bar'])
      controller.handleKeyDown(key('c'))
      controller.handleKeyDown(key('w'))
      expect(fake.editor.executeEdits).toHaveBeenCalledWith('vim', [
        {
          range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 },
          text: '',
        },
      ])
      expect(vim.modes.get('editor:test')).toBe('insert')
      controller.dispose()
    })

    it('does nothing for dh at column 1', () => {
      const { fake, vim, controller } = createNormalHarness(['abc'])
      controller.handleKeyDown(key('d'))
      controller.handleKeyDown(key('h'))
      expect(fake.editor.executeEdits).not.toHaveBeenCalled()
      expect(vim.modes.get('editor:test')).toBe('normal')
      controller.dispose()
    })

    it('shifts the whole range once for >j', () => {
      const { fake, controller } = createNormalHarness(['a', 'b', 'c'])
      controller.handleKeyDown(key('>'))
      controller.handleKeyDown(key('j'))
      expect(fake.editor.trigger).toHaveBeenCalledTimes(1)
      expect(fake.editor.trigger).toHaveBeenCalledWith('vim', 'editor.action.indentLines', null)
      controller.dispose()
    })
  })

  describe('paste cursor placement', () => {
    it('lands on the last pasted character for a one-line charwise paste', () => {
      const { fake, controller } = createNormalHarness(['abc'])
      setVimRegister({ text: 'xy', linewise: false })
      controller.handleKeyDown(key('p'))
      expect(fake.selection().startColumn).toBe(3)
      controller.dispose()
    })

    it('lands on the first non-blank of the first pasted line for a linewise paste', () => {
      const { fake, controller } = createNormalHarness(['  one', 'two'])
      setVimRegister({ text: '  pasted\n', linewise: true })
      controller.handleKeyDown(key('p'))
      expect(fake.selection()).toMatchObject({ startLineNumber: 2, startColumn: 3 })
      controller.dispose()
    })

    it('puts the cursor at the start of a multi-line charwise paste', () => {
      const { fake, controller } = createNormalHarness(['ab'])
      setVimRegister({ text: 'x\ny', linewise: false })
      controller.handleKeyDown(key('p'))
      expect(fake.editor.executeEdits).toHaveBeenCalledWith('vim', [
        {
          range: { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 2 },
          text: 'x\ny',
        },
      ])
      expect(fake.selection()).toMatchObject({ startLineNumber: 1, startColumn: 2 })
      controller.dispose()
    })
  })
})
