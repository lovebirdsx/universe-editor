/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/languageFeatures/OutlineService.ts
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  IFileService,
  InstantiationService,
  observableValue,
  ServiceCollection,
  URI,
  type IEditorService,
  type IFileService as IFileServiceType,
} from '@universe-editor/platform'
import type { monaco } from '../../../workbench/editor/monaco/MonacoLoader.js'
import { FileEditorInput } from '../../editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../editor/FileEditorRegistry.js'
import { MarkdownPreviewInput } from '../../editor/MarkdownPreviewInput.js'
import {
  MarkdownPreviewRegistry,
  type IMarkdownPreviewController,
} from '../../editor/MarkdownPreviewRegistry.js'
import { AcpSessionEditorInput } from '../../acp/acpSessionEditorInput.js'
import {
  IAcpSessionService,
  type IAcpSessionService as IAcpSessionServiceType,
} from '../../acp/acpSessionService.js'
import {
  IAcpSessionHistoryService,
  type IAcpSessionHistoryService as IAcpSessionHistoryServiceType,
} from '../../acp/acpSessionHistory.js'
import {
  IAcpChatWidgetService,
  type IAcpChatWidgetService as IAcpChatWidgetServiceType,
} from '../../acp/acpChatWidgetService.js'
import {
  AcpSessionOutlineRegistry,
  type IAcpSessionOutlineController,
} from '../../acp/acpSessionOutlineRegistry.js'
import { ACP_OUTLINE_LANGUAGE_ID } from '../../acp/acpTimelineOutline.js'
import type { TimelineItem } from '../../acp/acpSessionModel.js'
import type { ILanguageFeaturesService } from '../LanguageFeaturesService.js'
import { OutlineService } from '../OutlineService.js'

const { markerListeners, previewModels, modelAddListeners } = vi.hoisted(() => ({
  markerListeners: [] as Array<(resources: readonly { toString(): string }[]) => void>,
  previewModels: new Map<string, unknown>(),
  modelAddListeners: [] as Array<(uri: { toString(): string }) => void>,
}))

// OutlineService subscribes to monaco's marker changes to re-pull symbols once a
// language server is ready; stub MonacoLoader so the tests can drive that event.
vi.mock('../../../workbench/editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: {
    peek: () => ({
      editor: {
        onDidChangeMarkers: (cb: (resources: readonly { toString(): string }[]) => void) => {
          markerListeners.push(cb)
          return {
            dispose: () => {
              const i = markerListeners.indexOf(cb)
              if (i >= 0) markerListeners.splice(i, 1)
            },
          }
        },
      },
    }),
  },
}))

// The markdown-preview path pulls symbols from the source file's shared model;
// stub the registry so a test can plant a model for a given source URI.
vi.mock('../../../workbench/editor/monaco/MonacoModelRegistry.js', () => ({
  MonacoModelRegistry: {
    peek: (resource: { toString(): string }) => previewModels.get(resource.toString()),
    onDidAddModel: (cb: (uri: { toString(): string }) => void) => {
      modelAddListeners.push(cb)
      return {
        dispose: () => {
          const i = modelAddListeners.indexOf(cb)
          if (i >= 0) modelAddListeners.splice(i, 1)
        },
      }
    },
  },
}))

/** Simulate a model being acquired for `uri` (plant it, then fire the event). */
function addModel(uri: string, model: unknown): void {
  previewModels.set(uri, model)
  for (const cb of [...modelAddListeners]) cb({ toString: () => uri })
}

function fireMarkers(uri: string): void {
  for (const cb of [...markerListeners]) cb([{ toString: () => uri }])
}

const flush = (): Promise<void> => Promise.resolve().then(() => undefined)

function makeFs(): IFileServiceType {
  return {
    _serviceBrand: undefined,
    async readFileText() {
      return ''
    },
  } as unknown as IFileServiceType
}

function makeSymbol(
  name: string,
  startLine: number,
  endLine: number,
): monaco.languages.DocumentSymbol {
  return {
    name,
    detail: '',
    kind: 14 as monaco.languages.SymbolKind,
    tags: [],
    range: { startLineNumber: startLine, startColumn: 1, endLineNumber: endLine, endColumn: 1 },
    selectionRange: {
      startLineNumber: startLine,
      startColumn: 1,
      endLineNumber: startLine,
      endColumn: 1,
    },
    children: [],
  }
}

function makeFakeEditor(languageId: string) {
  let position: monaco.Position = { lineNumber: 1, column: 1 } as monaco.Position
  let cursorCb: (() => void) | undefined
  const model = {
    uri: { toString: () => 'file:///x.md' },
    getLanguageId: () => languageId,
    getValue: () => '',
    isDisposed: () => false,
    onDidChangeContent: () => ({ dispose: () => {} }),
  } as unknown as monaco.editor.ITextModel
  const editor = {
    getModel: () => model,
    getPosition: () => position,
    onDidChangeCursorPosition: (cb: () => void) => {
      cursorCb = cb
      return { dispose: () => {} }
    },
    setPosition: (p: monaco.Position) => {
      position = p
    },
    revealLineInCenterIfOutsideViewport: () => {},
    focus: () => {},
  } as unknown as monaco.editor.IStandaloneCodeEditor
  return {
    editor,
    moveCursorTo: (lineNumber: number) => {
      position = { lineNumber, column: 1 } as monaco.Position
      cursorCb?.()
    },
  }
}

/** Editor whose model carries a given URI; `getModel()` returns null once disposed. */
function makeFakeEditorFor(uri: string, languageId = 'markdown') {
  let disposed = false
  const model = {
    uri: { toString: () => uri },
    getLanguageId: () => languageId,
    getValue: () => '',
    isDisposed: () => disposed,
    onDidChangeContent: () => ({ dispose: () => {} }),
  } as unknown as monaco.editor.ITextModel
  const editor = {
    getModel: () => (disposed ? null : model),
    getPosition: () => ({ lineNumber: 1, column: 1 }) as monaco.Position,
    onDidChangeCursorPosition: () => ({ dispose: () => {} }),
    setPosition: () => {},
    revealLineInCenterIfOutsideViewport: () => {},
    focus: () => {},
  } as unknown as monaco.editor.IStandaloneCodeEditor
  return { editor, dispose: () => (disposed = true) }
}

describe('OutlineService', () => {
  beforeEach(() => {
    FileEditorRegistry._resetForTests()
    MarkdownPreviewRegistry._resetForTests()
    AcpSessionOutlineRegistry._resetForTests()
    previewModels.clear()
    markerListeners.length = 0
    modelAddListeners.length = 0
  })

  function setup(symbols: monaco.languages.DocumentSymbol[], languageId = 'markdown') {
    const services = new ServiceCollection()
    services.set(IFileService, makeFs())
    const inst = new InstantiationService(services)
    const input = inst.createInstance(FileEditorInput, URI.file('/ws/x.md'))

    const activeEditor = observableValue<FileEditorInput | undefined>('t', undefined)
    const editorService = { activeEditor } as unknown as IEditorService

    const changeEmitter = new Emitter<{ languageId: string }>()
    const provider = {
      provideDocumentSymbols: () => symbols,
    } as unknown as monaco.languages.DocumentSymbolProvider
    const facade = {
      onDidChangeDocumentSymbolProviders: changeEmitter.event,
      getDocumentSymbolProviders: (lang: string) => (lang === 'markdown' ? [provider] : []),
    } as unknown as ILanguageFeaturesService

    const fake = makeFakeEditor(languageId)
    const svc = new OutlineService(editorService, facade)
    return { svc, input, activeEditor, fake }
  }

  it('publishes the symbol tree when a markdown editor becomes active', async () => {
    const symbols = [makeSymbol('A', 1, 5)]
    const { svc, input, activeEditor, fake } = setup(symbols)
    FileEditorRegistry.register(input, fake.editor)
    activeEditor.set(input, undefined)
    await flush()
    expect(svc.outline.get()?.roots).toEqual(symbols)
    svc.dispose()
  })

  it('clears the outline when the active editor goes away', async () => {
    const { svc, input, activeEditor, fake } = setup([makeSymbol('A', 1, 5)])
    FileEditorRegistry.register(input, fake.editor)
    activeEditor.set(input, undefined)
    await flush()
    expect(svc.outline.get()).toBeDefined()
    activeEditor.set(undefined, undefined)
    expect(svc.outline.get()).toBeUndefined()
    svc.dispose()
  })

  it('updates the active symbol on cursor movement', async () => {
    const symbols = [makeSymbol('A', 1, 3), makeSymbol('B', 4, 10)]
    const { svc, input, activeEditor, fake } = setup(symbols)
    FileEditorRegistry.register(input, fake.editor)
    activeEditor.set(input, undefined)
    await flush()
    expect(svc.activeSymbol.get()?.name).toBe('A')
    fake.moveCursorTo(5)
    expect(svc.activeSymbol.get()?.name).toBe('B')
    svc.dispose()
  })

  it('yields an empty outline for a language with no provider', async () => {
    const { svc, input, activeEditor, fake } = setup([makeSymbol('A', 1, 5)], 'plaintext')
    FileEditorRegistry.register(input, fake.editor)
    activeEditor.set(input, undefined)
    await flush()
    expect(svc.outline.get()?.roots).toEqual([])
    svc.dispose()
  })

  it('re-pulls symbols when switching between two markdown files', async () => {
    const services = new ServiceCollection()
    services.set(IFileService, makeFs())
    const inst = new InstantiationService(services)
    const uriA = URI.file('/ws/a.md')
    const uriB = URI.file('/ws/b.md')
    const inputA = inst.createInstance(FileEditorInput, uriA)
    const inputB = inst.createInstance(FileEditorInput, uriB)

    const symbolsByUri: Record<string, monaco.languages.DocumentSymbol[]> = {
      [uriA.toString()]: [makeSymbol('Alpha', 1, 5)],
      [uriB.toString()]: [makeSymbol('Beta', 1, 9)],
    }
    const provider = {
      provideDocumentSymbols: (model: monaco.editor.ITextModel) =>
        symbolsByUri[model.uri.toString()] ?? [],
    } as unknown as monaco.languages.DocumentSymbolProvider
    const facade = {
      onDidChangeDocumentSymbolProviders: new Emitter<{ languageId: string }>().event,
      getDocumentSymbolProviders: (lang: string) => (lang === 'markdown' ? [provider] : []),
    } as unknown as ILanguageFeaturesService

    const activeEditor = observableValue<FileEditorInput | undefined>('t', undefined)
    const editorService = { activeEditor } as unknown as IEditorService
    const svc = new OutlineService(editorService, facade)

    FileEditorRegistry.register(inputA, makeFakeEditorFor(uriA.toString()).editor)
    FileEditorRegistry.register(inputB, makeFakeEditorFor(uriB.toString()).editor)

    activeEditor.set(inputA, undefined)
    await flush()
    expect(svc.outline.get()?.uri).toBe(uriA.toString())
    expect(svc.outline.get()?.roots).toEqual(symbolsByUri[uriA.toString()])

    activeEditor.set(inputB, undefined)
    await flush()
    expect(svc.outline.get()?.uri).toBe(uriB.toString())
    expect(svc.outline.get()?.roots).toEqual(symbolsByUri[uriB.toString()])

    activeEditor.set(inputA, undefined)
    await flush()
    expect(svc.outline.get()?.uri).toBe(uriA.toString())
    expect(svc.outline.get()?.roots).toEqual(symbolsByUri[uriA.toString()])
    svc.dispose()
  })

  it('re-pulls symbols when the active model markers change after a server becomes ready', async () => {
    const services = new ServiceCollection()
    services.set(IFileService, makeFs())
    const inst = new InstantiationService(services)
    const input = inst.createInstance(FileEditorInput, URI.file('/ws/x.md'))

    const symbols = [makeSymbol('Ready', 1, 5)]
    let ready = false
    const provider = {
      provideDocumentSymbols: () => (ready ? symbols : []),
    } as unknown as monaco.languages.DocumentSymbolProvider
    const facade = {
      onDidChangeDocumentSymbolProviders: new Emitter<{ languageId: string }>().event,
      getDocumentSymbolProviders: (lang: string) => (lang === 'markdown' ? [provider] : []),
    } as unknown as ILanguageFeaturesService

    const activeEditor = observableValue<FileEditorInput | undefined>('t', undefined)
    const editorService = { activeEditor } as unknown as IEditorService
    const svc = new OutlineService(editorService, facade)

    FileEditorRegistry.register(input, makeFakeEditorFor('file:///ws/x.md').editor)
    activeEditor.set(input, undefined)
    await flush()
    // First pull happens before the server is ready: empty outline.
    expect(svc.outline.get()?.roots).toEqual([])

    ready = true
    fireMarkers('file:///ws/x.md')
    await new Promise((r) => setTimeout(r, 250)) // wait past the recompute debounce
    expect(svc.outline.get()?.roots).toEqual(symbols)
    svc.dispose()
  })

  it('re-pulls after an empty initial pull even with no marker change (warm server / 2nd file)', async () => {
    const services = new ServiceCollection()
    services.set(IFileService, makeFs())
    const inst = new InstantiationService(services)
    const input = inst.createInstance(FileEditorInput, URI.file('/ws/x.md'))

    // Server is warm but the just-opened file isn't analysed yet: the first pull
    // returns [], later pulls return the symbols. No diagnostics/marker change is
    // fired (a warm server may have pushed them before we attached).
    const symbols = [makeSymbol('Late', 1, 5)]
    let calls = 0
    const provider = {
      provideDocumentSymbols: () => (calls++ === 0 ? [] : symbols),
    } as unknown as monaco.languages.DocumentSymbolProvider
    const facade = {
      onDidChangeDocumentSymbolProviders: new Emitter<{ languageId: string }>().event,
      getDocumentSymbolProviders: (lang: string) => (lang === 'markdown' ? [provider] : []),
    } as unknown as ILanguageFeaturesService

    const activeEditor = observableValue<FileEditorInput | undefined>('t', undefined)
    const editorService = { activeEditor } as unknown as IEditorService
    const svc = new OutlineService(editorService, facade)

    FileEditorRegistry.register(input, makeFakeEditorFor('file:///ws/x.md').editor)
    activeEditor.set(input, undefined)
    await flush()
    expect(svc.outline.get()?.roots).toEqual([])

    await new Promise((r) => setTimeout(r, 500)) // wait for the empty-pull retry
    expect(svc.outline.get()?.roots).toEqual(symbols)
    svc.dispose()
  })

  it('keeps retrying the initial pull until a provider registers (provider not ready at attach)', async () => {
    const services = new ServiceCollection()
    services.set(IFileService, makeFs())
    const inst = new InstantiationService(services)
    const input = inst.createInstance(FileEditorInput, URI.file('/ws/x.md'))

    // The language provider (e.g. tsserver via the extension host) registers
    // asynchronously, AFTER the editor is attached — and no provider-change event
    // is observed here. The initial pull must keep retrying until it appears.
    const symbols = [makeSymbol('A', 1, 5)]
    let registered = false
    const provider = {
      provideDocumentSymbols: () => symbols,
    } as unknown as monaco.languages.DocumentSymbolProvider
    const facade = {
      onDidChangeDocumentSymbolProviders: new Emitter<{ languageId: string }>().event,
      getDocumentSymbolProviders: (lang: string) =>
        lang === 'markdown' && registered ? [provider] : [],
    } as unknown as ILanguageFeaturesService

    const activeEditor = observableValue<FileEditorInput | undefined>('t', undefined)
    const editorService = { activeEditor } as unknown as IEditorService
    const svc = new OutlineService(editorService, facade)

    FileEditorRegistry.register(input, makeFakeEditorFor('file:///ws/x.md').editor)
    activeEditor.set(input, undefined)
    await flush()
    expect(svc.outline.get()?.roots).toEqual([]) // no provider registered yet

    registered = true
    await new Promise((r) => setTimeout(r, 500)) // retry should discover the provider
    expect(svc.outline.get()?.roots).toEqual(symbols)
    svc.dispose()
  })

  it('retries with backoff when a provider registers but its first pull is still empty', async () => {
    const services = new ServiceCollection()
    services.set(IFileService, makeFs())
    const inst = new InstantiationService(services)
    const input = inst.createInstance(FileEditorInput, URI.file('/ws/x.md'))

    // Real TS flow: no provider at attach; later the provider registers (fires the
    // change event) but its first pull returns [] because tsserver hasn't analysed
    // the file yet; a subsequent pull returns the symbols.
    const symbols = [makeSymbol('Late', 1, 5)]
    let registered = false
    let calls = 0
    const provider = {
      provideDocumentSymbols: () => (calls++ === 0 ? [] : symbols),
    } as unknown as monaco.languages.DocumentSymbolProvider
    const changeEmitter = new Emitter<{ languageId: string }>()
    const facade = {
      onDidChangeDocumentSymbolProviders: changeEmitter.event,
      getDocumentSymbolProviders: (lang: string) =>
        lang === 'markdown' && registered ? [provider] : [],
    } as unknown as ILanguageFeaturesService

    const activeEditor = observableValue<FileEditorInput | undefined>('t', undefined)
    const editorService = { activeEditor } as unknown as IEditorService
    const svc = new OutlineService(editorService, facade)

    FileEditorRegistry.register(input, makeFakeEditorFor('file:///ws/x.md').editor)
    activeEditor.set(input, undefined)
    await flush()
    expect(svc.outline.get()?.roots).toEqual([])

    registered = true
    changeEmitter.fire({ languageId: 'markdown' })
    await new Promise((r) => setTimeout(r, 500)) // first pull empty → retry → symbols
    expect(svc.outline.get()?.roots).toEqual(symbols)
    svc.dispose()
  })

  it('keeps retrying long enough for a slow server that outlasts the old fixed window', async () => {
    vi.useFakeTimers()
    try {
      const services = new ServiceCollection()
      services.set(IFileService, makeFs())
      const inst = new InstantiationService(services)
      const input = inst.createInstance(FileEditorInput, URI.file('/ws/x.md'))

      // A cold tsserver / large file stays empty across many pulls. The old fixed
      // 6×250ms window gave only 7 pulls and would give up while still empty; the
      // backoff window must keep pulling until the server finally answers.
      const symbols = [makeSymbol('Slow', 1, 5)]
      let calls = 0
      const provider = {
        provideDocumentSymbols: () => (calls++ >= 7 ? symbols : []),
      } as unknown as monaco.languages.DocumentSymbolProvider
      const facade = {
        onDidChangeDocumentSymbolProviders: new Emitter<{ languageId: string }>().event,
        getDocumentSymbolProviders: (lang: string) => (lang === 'markdown' ? [provider] : []),
      } as unknown as ILanguageFeaturesService

      const activeEditor = observableValue<FileEditorInput | undefined>('t', undefined)
      const editorService = { activeEditor } as unknown as IEditorService
      const svc = new OutlineService(editorService, facade)

      FileEditorRegistry.register(input, makeFakeEditorFor('file:///ws/x.md').editor)
      activeEditor.set(input, undefined)
      await vi.advanceTimersByTimeAsync(0)
      expect(svc.outline.get()?.roots).toEqual([])

      // Drive every backoff retry; the outline must fill in once the server answers.
      await vi.advanceTimersByTimeAsync(20000)
      expect(svc.outline.get()?.roots).toEqual(symbols)
      svc.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fills the outline even when a cold server only answers long after the backoff window', async () => {
    vi.useFakeTimers()
    try {
      const services = new ServiceCollection()
      services.set(IFileService, makeFs())
      const inst = new InstantiationService(services)
      const input = inst.createInstance(FileEditorInput, URI.file('/ws/x.md'))

      // A large project's tsserver can take a minute to warm up. The file is clean
      // (no diagnostics → no marker event) and isn't edited, so the ONLY way the
      // outline ever fills is the service continuing to poll past its fast backoff.
      // This is the "restored editor stays permanently empty" report: a finite
      // backoff window gives up while the server is still cold.
      const symbols = [makeSymbol('VerySlow', 1, 5)]
      let ready = false
      const provider = {
        provideDocumentSymbols: () => (ready ? symbols : []),
      } as unknown as monaco.languages.DocumentSymbolProvider
      const facade = {
        onDidChangeDocumentSymbolProviders: new Emitter<{ languageId: string }>().event,
        getDocumentSymbolProviders: (lang: string) => (lang === 'markdown' ? [provider] : []),
      } as unknown as ILanguageFeaturesService

      const activeEditor = observableValue<FileEditorInput | undefined>('t', undefined)
      const editorService = { activeEditor } as unknown as IEditorService
      const svc = new OutlineService(editorService, facade)

      FileEditorRegistry.register(input, makeFakeEditorFor('file:///ws/x.md').editor)
      activeEditor.set(input, undefined)
      await vi.advanceTimersByTimeAsync(0)
      expect(svc.outline.get()?.roots).toEqual([])

      // The server is still cold well past the fast backoff window (~16s).
      await vi.advanceTimersByTimeAsync(20000)
      expect(svc.outline.get()?.roots).toEqual([])

      // It finally warms up at ~45s; the outline must still fill in on its own.
      ready = true
      await vi.advanceTimersByTimeAsync(45000)
      expect(svc.outline.get()?.roots).toEqual(symbols)
      svc.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('previewSymbol scrolls + highlights without moving the cursor or stealing focus', async () => {
    const symbols = [makeSymbol('A', 1, 3), makeSymbol('B', 4, 10)]
    const { svc, input, activeEditor } = setup(symbols)
    const calls = {
      focus: 0,
      setPosition: 0,
      revealLineInCenter: [] as number[],
      decorationSets: 0,
      decorationClears: 0,
    }
    const collection = {
      set: () => {
        calls.decorationSets++
      },
      clear: () => {
        calls.decorationClears++
      },
    }
    const editor = {
      getModel: () =>
        ({
          uri: { toString: () => 'file:///ws/x.md' },
          getLanguageId: () => 'markdown',
          isDisposed: () => false,
          onDidChangeContent: () => ({ dispose: () => {} }),
        }) as unknown as monaco.editor.ITextModel,
      getPosition: () => ({ lineNumber: 1, column: 1 }) as monaco.Position,
      onDidChangeCursorPosition: () => ({ dispose: () => {} }),
      setPosition: () => {
        calls.setPosition++
      },
      focus: () => {
        calls.focus++
      },
      revealLineInCenter: (n: number) => {
        calls.revealLineInCenter.push(n)
      },
      revealLineInCenterIfOutsideViewport: () => {},
      createDecorationsCollection: () => collection,
    } as unknown as monaco.editor.IStandaloneCodeEditor

    FileEditorRegistry.register(input, editor)
    activeEditor.set(input, undefined)
    await flush()

    svc.previewSymbol(symbols[1]!)
    expect(calls.revealLineInCenter).toEqual([4])
    expect(calls.decorationSets).toBe(1)
    expect(calls.setPosition).toBe(0)
    expect(calls.focus).toBe(0)
    svc.dispose()
  })

  it('captureViewState / restoreViewState round-trips selection + scroll and clears preview', async () => {
    const symbols = [makeSymbol('A', 1, 3)]
    const { svc, input, activeEditor } = setup(symbols)
    const selection = { startLineNumber: 7, startColumn: 2 } as unknown as monaco.Selection
    const restored: { selection?: monaco.Selection; scrollTop?: number; scrollLeft?: number } = {}
    let decorationClears = 0
    const editor = {
      getModel: () =>
        ({
          uri: { toString: () => 'file:///ws/x.md' },
          getLanguageId: () => 'markdown',
          isDisposed: () => false,
          onDidChangeContent: () => ({ dispose: () => {} }),
        }) as unknown as monaco.editor.ITextModel,
      getPosition: () => ({ lineNumber: 1, column: 1 }) as monaco.Position,
      onDidChangeCursorPosition: () => ({ dispose: () => {} }),
      getSelection: () => selection,
      getScrollTop: () => 120,
      getScrollLeft: () => 30,
      setSelection: (s: monaco.Selection) => {
        restored.selection = s
      },
      setScrollTop: (n: number) => {
        restored.scrollTop = n
      },
      setScrollLeft: (n: number) => {
        restored.scrollLeft = n
      },
      revealLineInCenter: () => {},
      revealLineInCenterIfOutsideViewport: () => {},
      createDecorationsCollection: () => ({ set: () => {}, clear: () => decorationClears++ }),
      focus: () => {},
      setPosition: () => {},
    } as unknown as monaco.editor.IStandaloneCodeEditor

    FileEditorRegistry.register(input, editor)
    activeEditor.set(input, undefined)
    await flush()

    const state = svc.captureViewState()
    expect(state).toEqual({ selection, scrollTop: 120, scrollLeft: 30 })

    svc.previewSymbol(symbols[0]!)
    svc.restoreViewState(state!)
    expect(restored).toEqual({ selection, scrollTop: 120, scrollLeft: 30 })
    expect(decorationClears).toBeGreaterThan(0)
    svc.dispose()
  })

  // ---- markdown preview -----------------------------------------------------

  function setupPreview(symbols: monaco.languages.DocumentSymbol[]) {
    const sourceUri = URI.file('/ws/x.md')
    const model = {
      uri: { toString: () => sourceUri.toString() },
      getLanguageId: () => 'markdown',
      getValue: () => '',
      isDisposed: () => false,
      onDidChangeContent: () => ({ dispose: () => {} }),
    } as unknown as monaco.editor.ITextModel
    previewModels.set(sourceUri.toString(), model)

    const activeEditor = observableValue<MarkdownPreviewInput | undefined>('t', undefined)
    const editorService = { activeEditor } as unknown as IEditorService
    const provider = {
      provideDocumentSymbols: () => symbols,
    } as unknown as monaco.languages.DocumentSymbolProvider
    const facade = {
      onDidChangeDocumentSymbolProviders: new Emitter<{ languageId: string }>().event,
      getDocumentSymbolProviders: (lang: string) => (lang === 'markdown' ? [provider] : []),
    } as unknown as ILanguageFeaturesService

    const svc = new OutlineService(editorService, facade)
    const preview = new MarkdownPreviewInput(sourceUri)
    return { svc, preview, sourceUri, activeEditor }
  }

  function makeController(overrides: Partial<IMarkdownPreviewController> = {}) {
    const scrolled: number[] = []
    let focusCount = 0
    const onDidScroll = new Emitter<void>()
    const controller: IMarkdownPreviewController = {
      scrollToLine: (line: number) => scrolled.push(line),
      scrollToAnchor: () => {},
      getTopVisibleLine: () => 1,
      focus: () => {
        focusCount += 1
      },
      onDidScroll: onDidScroll.event,
      openFind: () => {},
      closeFind: () => {},
      findNext: () => {},
      findPrev: () => {},
      showLinkHints: () => {},
      hideLinkHints: () => {},
      toggleHelp: () => {},
      ...overrides,
    }
    return { controller, scrolled, onDidScroll, focusCount: () => focusCount }
  }

  it('publishes symbols for an active markdown preview from the source model', async () => {
    const symbols = [makeSymbol('Title', 1, 9)]
    const { svc, preview, sourceUri, activeEditor } = setupPreview(symbols)
    MarkdownPreviewRegistry.register(sourceUri, makeController().controller)
    activeEditor.set(preview, undefined)
    await flush()
    expect(svc.outline.get()?.roots).toEqual(symbols)
    expect(svc.outline.get()?.uri).toBe(sourceUri.toString())
    svc.dispose()
  })

  it('revealSymbol scrolls the preview to the symbol line and refocuses it', async () => {
    const symbols = [makeSymbol('A', 1, 3), makeSymbol('B', 5, 10)]
    const { svc, preview, sourceUri, activeEditor } = setupPreview(symbols)
    const { controller, scrolled, focusCount } = makeController()
    MarkdownPreviewRegistry.register(sourceUri, controller)
    activeEditor.set(preview, undefined)
    await flush()
    svc.revealSymbol(symbols[1]!)
    expect(scrolled).toEqual([5])
    expect(focusCount()).toBe(1)
    svc.dispose()
  })

  it('tracks the active symbol from the preview top visible line on scroll', async () => {
    const symbols = [makeSymbol('A', 1, 4), makeSymbol('B', 5, 10)]
    let topLine = 1
    const { svc, preview, sourceUri, activeEditor } = setupPreview(symbols)
    const { controller, onDidScroll } = makeController({ getTopVisibleLine: () => topLine })
    MarkdownPreviewRegistry.register(sourceUri, controller)
    activeEditor.set(preview, undefined)
    await flush()
    expect(svc.activeSymbol.get()?.name).toBe('A')
    topLine = 6
    onDidScroll.fire()
    expect(svc.activeSymbol.get()?.name).toBe('B')
    svc.dispose()
  })

  it('clears the outline for a preview whose source model is not open', async () => {
    const symbols = [makeSymbol('A', 1, 3)]
    const { svc, preview, sourceUri, activeEditor } = setupPreview(symbols)
    previewModels.delete(sourceUri.toString())
    activeEditor.set(preview, undefined)
    await flush()
    expect(svc.outline.get()).toBeUndefined()
    svc.dispose()
  })

  it('fills the outline once a link-navigated preview acquires its source model', async () => {
    const symbols = [makeSymbol('Heading', 1, 9)]
    const { svc, preview, sourceUri, activeEditor } = setupPreview(symbols)
    // Link-navigated preview: source model not open yet when it becomes active.
    previewModels.delete(sourceUri.toString())
    MarkdownPreviewRegistry.register(sourceUri, makeController().controller)
    activeEditor.set(preview, undefined)
    await flush()
    expect(svc.outline.get()?.roots ?? []).toEqual([])

    // The preview component acquires the source model from disk (async); the
    // registry's onDidAddModel must drive a re-pull that fills the outline.
    const model = {
      uri: { toString: () => sourceUri.toString() },
      getLanguageId: () => 'markdown',
      getValue: () => '',
      isDisposed: () => false,
      onDidChangeContent: () => ({ dispose: () => {} }),
    } as unknown as monaco.editor.ITextModel
    addModel(sourceUri.toString(), model)
    await flush()
    expect(svc.outline.get()?.roots).toEqual(symbols)
    svc.dispose()
  })

  // ---- agent session --------------------------------------------------------

  function makeSessionInput(sessionId: string): AcpSessionEditorInput {
    // A real instance is required so OutlineService's `instanceof` branch matches.
    const sessions = {
      _serviceBrand: undefined,
      entries: observableValue<readonly unknown[]>('t.sessions', []),
      getById: () => undefined,
    } as unknown as IAcpSessionServiceType
    const history = {
      _serviceBrand: undefined,
      entries: observableValue<readonly unknown[]>('t.history', []),
      get: () => undefined,
    } as unknown as IAcpSessionHistoryServiceType
    const chatWidget = {
      _serviceBrand: undefined,
      focusSessionInput: () => false,
    } as unknown as IAcpChatWidgetServiceType
    const services = new ServiceCollection()
    services.set(IAcpSessionService, sessions)
    services.set(IAcpSessionHistoryService, history)
    services.set(IAcpChatWidgetService, chatWidget)
    const inst = new InstantiationService(services)
    return inst.createInstance(AcpSessionEditorInput, sessionId, 'fake', undefined)
  }

  function setupSession() {
    const activeEditor = observableValue<AcpSessionEditorInput | undefined>('t', undefined)
    const editorService = { activeEditor } as unknown as IEditorService
    const facade = {
      onDidChangeDocumentSymbolProviders: new Emitter<{ languageId: string }>().event,
      getDocumentSymbolProviders: () => [],
    } as unknown as ILanguageFeaturesService
    const svc = new OutlineService(editorService, facade)
    const input = makeSessionInput('s1')
    return { svc, input, activeEditor }
  }

  function makeSessionController(timelineItems: readonly TimelineItem[]) {
    const timeline = observableValue<readonly TimelineItem[]>('tl', timelineItems)
    const onDidChangeActive = new Emitter<void>()
    const scrolled: string[] = []
    let focusCount = 0
    let activeKey: string | undefined
    const controller: IAcpSessionOutlineController = {
      timeline,
      scrollToKey: (key) => scrolled.push(key),
      getActiveKey: () => activeKey,
      focus: () => {
        focusCount += 1
      },
      onDidChangeActive: onDidChangeActive.event,
    }
    return {
      controller,
      timeline,
      onDidChangeActive,
      scrolled,
      focusCount: () => focusCount,
      setActiveKey: (k: string | undefined) => {
        activeKey = k
      },
    }
  }

  function tlMessage(id: string, role: 'user' | 'agent' | 'thought', text: string): TimelineItem {
    return { kind: 'message', id, message: { id, role, text, blocks: [], streaming: false } }
  }

  it('publishes an outline synthesized from the session timeline', async () => {
    const { svc, input, activeEditor } = setupSession()
    const { controller } = makeSessionController([
      tlMessage('m1', 'user', 'Question one'),
      tlMessage('m2', 'agent', 'Answer'),
    ])
    AcpSessionOutlineRegistry.register('s1', controller)
    activeEditor.set(input, undefined)
    await flush()
    expect(svc.outline.get()?.languageId).toBe(ACP_OUTLINE_LANGUAGE_ID)
    // The agent reply nests under the user turn (conversation grouping).
    const roots = svc.outline.get()?.roots ?? []
    expect(roots.map((r) => r.name)).toEqual(['Question one'])
    expect((roots[0]!.children ?? []).map((c) => c.name)).toEqual(['Answer'])
    svc.dispose()
  })

  it('attaches once the ChatBody controller registers after activation', async () => {
    const { svc, input, activeEditor } = setupSession()
    // Session editor active but ChatBody not mounted yet: outline empty.
    activeEditor.set(input, undefined)
    await flush()
    expect(svc.outline.get()).toBeUndefined()

    const { controller } = makeSessionController([tlMessage('m1', 'user', 'Late mount')])
    AcpSessionOutlineRegistry.register('s1', controller)
    await flush()
    expect(svc.outline.get()?.roots.map((r) => r.name)).toEqual(['Late mount'])
    svc.dispose()
  })

  it('rebuilds the outline when the timeline changes', async () => {
    const { svc, input, activeEditor } = setupSession()
    const { controller, timeline } = makeSessionController([tlMessage('m1', 'user', 'First')])
    AcpSessionOutlineRegistry.register('s1', controller)
    activeEditor.set(input, undefined)
    await flush()
    expect(svc.outline.get()?.roots).toHaveLength(1)

    timeline.set([tlMessage('m1', 'user', 'First'), tlMessage('m2', 'agent', 'Second')], undefined)
    await flush()
    // 'Second' (agent) nests under 'First' (user), so there is still one root.
    const roots = svc.outline.get()?.roots ?? []
    expect(roots.map((r) => r.name)).toEqual(['First'])
    expect((roots[0]!.children ?? []).map((c) => c.name)).toEqual(['Second'])
    svc.dispose()
  })

  it('tracks the active item from the session active slot on change', async () => {
    const { svc, input, activeEditor } = setupSession()
    const { controller, onDidChangeActive, setActiveKey } = makeSessionController([
      tlMessage('m1', 'user', 'First'),
      tlMessage('m2', 'agent', 'Second'),
    ])
    setActiveKey('m:m1')
    AcpSessionOutlineRegistry.register('s1', controller)
    activeEditor.set(input, undefined)
    await flush()
    expect(svc.activeSymbol.get()?.name).toBe('First')
    // A keyboard move (Alt+Down) or a scroll both surface as an active-key change.
    setActiveKey('m:m2')
    onDidChangeActive.fire()
    expect(svc.activeSymbol.get()?.name).toBe('Second')
    svc.dispose()
  })

  it('revealSymbol scrolls the chat to the slot key and refocuses it', async () => {
    const { svc, input, activeEditor } = setupSession()
    const { controller, scrolled, focusCount } = makeSessionController([
      tlMessage('m1', 'user', 'First'),
      tlMessage('m2', 'agent', 'Second'),
    ])
    AcpSessionOutlineRegistry.register('s1', controller)
    activeEditor.set(input, undefined)
    await flush()
    // 'Second' nests under 'First'; reach it through the grouped tree.
    const second = svc.outline.get()!.roots[0]!.children![0]!
    svc.revealSymbol(second)
    expect(scrolled).toEqual(['m:m2'])
    expect(focusCount()).toBe(1)
    svc.dispose()
  })

  // Repro for the reported bug in the REAL mount order: the editor activates
  // BEFORE the ChatBody mounts, so the first attach finds no controller and
  // bails. The controller then registers late (onDidChange → re-attach). Moving
  // the session's keyboard selection must retrack the active symbol — i.e. the
  // late re-attach has to (re)subscribe onDidChangeActive, not just build the
  // tree once.
  it('tracks the active slot after the controller registers late (editor active first)', async () => {
    const { svc, input, activeEditor } = setupSession()
    // Editor active, ChatBody not mounted yet.
    activeEditor.set(input, undefined)
    await flush()
    expect(svc.outline.get()).toBeUndefined()

    const { controller, onDidChangeActive, setActiveKey } = makeSessionController([
      tlMessage('m1', 'user', 'First'),
      tlMessage('m2', 'agent', 'Second'),
    ])
    setActiveKey('m:m1')
    AcpSessionOutlineRegistry.register('s1', controller)
    await flush()
    expect(svc.activeSymbol.get()?.name).toBe('First')

    // The user moves the selection in the chat (Alt+Down). The outline highlight
    // must follow — this is the path that was silently broken.
    setActiveKey('m:m2')
    onDidChangeActive.fire()
    expect(svc.activeSymbol.get()?.name).toBe('Second')
    svc.dispose()
  })

  it('clears the outline when leaving the session editor', async () => {
    const { svc, input, activeEditor } = setupSession()
    const { controller } = makeSessionController([tlMessage('m1', 'user', 'First')])
    AcpSessionOutlineRegistry.register('s1', controller)
    activeEditor.set(input, undefined)
    await flush()
    expect(svc.outline.get()).toBeDefined()
    activeEditor.set(undefined, undefined)
    expect(svc.outline.get()).toBeUndefined()
    svc.dispose()
  })
})
