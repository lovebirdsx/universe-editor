/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/languageFeatures/OutlineService.ts
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest'
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
import type { ILanguageFeaturesService } from '../LanguageFeaturesService.js'
import { OutlineService } from '../OutlineService.js'

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
})
