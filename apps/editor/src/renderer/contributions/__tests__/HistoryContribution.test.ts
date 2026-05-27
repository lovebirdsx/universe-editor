/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ContextKeyService,
  Emitter,
  IContextKeyService,
  IFileService,
  IHistoryService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IFileService as IFileServiceType,
} from '@universe-editor/platform'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import { HistoryService } from '../../services/history/HistoryService.js'
import { HistoryContribution } from '../HistoryContribution.js'

interface FakeMonacoEditor {
  position: { lineNumber: number; column: number }
  uri: URI
  cursorEmitter: Emitter<void>
  disposeEmitter: Emitter<void>
  onDidChangeCursorPosition(cb: () => void): { dispose(): void }
  onDidDispose(cb: () => void): { dispose(): void }
  getPosition(): { lineNumber: number; column: number } | null
  getModel(): { uri: URI } | null
  triggerCursor(): void
  triggerDispose(): void
}

function makeFakeEditor(uri: URI): FakeMonacoEditor {
  const cursorEmitter = new Emitter<void>()
  const disposeEmitter = new Emitter<void>()
  const m: FakeMonacoEditor = {
    position: { lineNumber: 1, column: 1 },
    uri,
    cursorEmitter,
    disposeEmitter,
    onDidChangeCursorPosition: (cb) => cursorEmitter.event(cb),
    onDidDispose: (cb) => disposeEmitter.event(cb),
    getPosition() {
      return m.position
    },
    getModel() {
      return { uri: m.uri }
    },
    triggerCursor() {
      cursorEmitter.fire()
    },
    triggerDispose() {
      disposeEmitter.fire()
    },
  }
  return m
}

function makeFileService(): IFileServiceType {
  return {
    _serviceBrand: undefined,
    async readFile() {
      return new Uint8Array()
    },
    async readFileText() {
      return ''
    },
    async writeFile() {},
    async exists() {
      return false
    },
    async stat() {
      throw new Error('not used')
    },
    async list() {
      return []
    },
    async createDirectory() {},
    async delete() {},
    async rename() {},
    async listRecursive() {
      return []
    },
  }
}

function setup() {
  FileEditorRegistry._resetForTests()
  const services = new ServiceCollection()
  services.set(IFileService, makeFileService())
  const contextKeyService = new ContextKeyService()
  services.set(IContextKeyService, contextKeyService)
  const historyService = new HistoryService()
  services.set(IHistoryService, historyService)
  const inst = new InstantiationService(services)
  const contrib = inst.createInstance(HistoryContribution)
  return { historyService, contextKeyService, inst, contrib }
}

describe('HistoryContribution', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FileEditorRegistry._resetForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
    FileEditorRegistry._resetForTests()
  })

  it('seeds canGoBack / canGoForward context keys to false', () => {
    const { contextKeyService } = setup()
    expect(contextKeyService.get('canGoBack')).toBe(false)
    expect(contextKeyService.get('canGoForward')).toBe(false)
  })

  it('updates context keys when history changes', () => {
    const { historyService, contextKeyService } = setup()
    historyService.record({ resource: URI.file('/a.ts') })
    historyService.record({ resource: URI.file('/b.ts') })
    expect(contextKeyService.get('canGoBack')).toBe(true)
    historyService.goBack()
    expect(contextKeyService.get('canGoForward')).toBe(true)
  })

  it('records a cursor change after the debounce window', () => {
    const { historyService, inst } = setup()
    const uri = URI.file('/a.ts')
    const input = inst.createInstance(FileEditorInput, uri)
    const editor = makeFakeEditor(uri)
    FileEditorRegistry.register(
      input,
      editor as unknown as Parameters<typeof FileEditorRegistry.register>[1],
    )
    editor.position = { lineNumber: 5, column: 1 }
    editor.triggerCursor()
    vi.advanceTimersByTime(300)
    expect(historyService.getBackStack().length).toBe(1)
    expect(historyService.getBackStack()[0]?.selection?.startLine).toBe(5)
  })

  it('ignores cursor changes with line delta <= 10 on the same file', () => {
    const { historyService, inst } = setup()
    const uri = URI.file('/a.ts')
    const input = inst.createInstance(FileEditorInput, uri)
    const editor = makeFakeEditor(uri)
    FileEditorRegistry.register(
      input,
      editor as unknown as Parameters<typeof FileEditorRegistry.register>[1],
    )
    editor.position = { lineNumber: 5, column: 1 }
    editor.triggerCursor()
    vi.advanceTimersByTime(300)
    editor.position = { lineNumber: 8, column: 1 }
    editor.triggerCursor()
    vi.advanceTimersByTime(300)
    expect(historyService.getBackStack().length).toBe(1)
  })

  it('records when the line delta crosses the threshold', () => {
    const { historyService, inst } = setup()
    const uri = URI.file('/a.ts')
    const input = inst.createInstance(FileEditorInput, uri)
    const editor = makeFakeEditor(uri)
    FileEditorRegistry.register(
      input,
      editor as unknown as Parameters<typeof FileEditorRegistry.register>[1],
    )
    editor.position = { lineNumber: 5, column: 1 }
    editor.triggerCursor()
    vi.advanceTimersByTime(300)
    editor.position = { lineNumber: 50, column: 1 }
    editor.triggerCursor()
    vi.advanceTimersByTime(300)
    expect(historyService.getBackStack().length).toBe(2)
  })

  it('records on file change regardless of line delta', () => {
    const { historyService, inst } = setup()
    const uriA = URI.file('/a.ts')
    const inputA = inst.createInstance(FileEditorInput, uriA)
    const editor = makeFakeEditor(uriA)
    FileEditorRegistry.register(
      inputA,
      editor as unknown as Parameters<typeof FileEditorRegistry.register>[1],
    )
    editor.position = { lineNumber: 5, column: 1 }
    editor.triggerCursor()
    vi.advanceTimersByTime(300)

    // Same Monaco instance, model swapped to file B (this is what happens on tab switch).
    editor.uri = URI.file('/b.ts')
    editor.position = { lineNumber: 5, column: 1 }
    editor.triggerCursor()
    vi.advanceTimersByTime(300)

    expect(historyService.getBackStack().length).toBe(2)
    expect(historyService.getBackStack()[1]?.resource.fsPath).toBe(URI.file('/b.ts').fsPath)
  })

  it('detaches when the Monaco editor disposes', () => {
    const { historyService, inst } = setup()
    const uri = URI.file('/a.ts')
    const input = inst.createInstance(FileEditorInput, uri)
    const editor = makeFakeEditor(uri)
    FileEditorRegistry.register(
      input,
      editor as unknown as Parameters<typeof FileEditorRegistry.register>[1],
    )
    editor.triggerDispose()
    editor.position = { lineNumber: 99, column: 1 }
    editor.triggerCursor()
    vi.advanceTimersByTime(300)
    expect(historyService.getBackStack().length).toBe(0)
  })

  it('does not double-attach when the same editor re-registers', () => {
    const { historyService, inst } = setup()
    const uri = URI.file('/a.ts')
    const input = inst.createInstance(FileEditorInput, uri)
    const editor = makeFakeEditor(uri)
    FileEditorRegistry.register(
      input,
      editor as unknown as Parameters<typeof FileEditorRegistry.register>[1],
    )
    FileEditorRegistry.register(
      input,
      editor as unknown as Parameters<typeof FileEditorRegistry.register>[1],
    )
    editor.position = { lineNumber: 50, column: 1 }
    editor.triggerCursor()
    vi.advanceTimersByTime(300)
    expect(historyService.getBackStack().length).toBe(1)
  })
})
