/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ContextKeyService,
  EditorInput as ImportedEditorInput,
  Emitter,
  IContextKeyService,
  IEditorService,
  IFileService,
  IHistoryService,
  IStorageService,
  InstantiationService,
  ServiceCollection,
  URI,
  derived,
  observableValue,
  type IEditorInput,
  type IEditorService as IEditorServiceType,
  type IFileService as IFileServiceType,
  type IStorageService as IStorageServiceType,
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
    async copy() {},
    async listRecursive() {
      return []
    },
  }
}

function makeFakeEditorService(): {
  service: IEditorServiceType
  setActive: (input: IEditorInput | undefined) => void
} {
  const openEditors = observableValue<readonly IEditorInput[]>('openEditors', [])
  const activeEditor = observableValue<IEditorInput | undefined>('activeEditor', undefined)
  const activeEditorId = derived((reader) => activeEditor.read(reader)?.id)
  const service: IEditorServiceType = {
    _serviceBrand: undefined,
    openEditor: () => {},
    closeEditor: () => {},
    closeAllEditors: () => {},
    openEditors,
    activeEditorId,
    activeEditor,
  }
  return {
    service,
    setActive: (input) => activeEditor.set(input, undefined),
  }
}

function makeFakeStorageService(): {
  service: IStorageServiceType
  swapWorkspaceScope: () => void
} {
  const scope = new Emitter<void>()
  const service: IStorageServiceType = {
    _serviceBrand: undefined,
    async get() {
      return undefined
    },
    async set() {},
    async remove() {},
    onDidChangeWorkspaceScope: scope.event,
  }
  return { service, swapWorkspaceScope: () => scope.fire() }
}

function setup() {
  FileEditorRegistry._resetForTests()
  const services = new ServiceCollection()
  services.set(IFileService, makeFileService())
  const contextKeyService = new ContextKeyService()
  services.set(IContextKeyService, contextKeyService)
  const historyService = new HistoryService()
  services.set(IHistoryService, historyService)
  const editor = makeFakeEditorService()
  services.set(IEditorService, editor.service)
  const storage = makeFakeStorageService()
  services.set(IStorageService, storage.service)
  const inst = new InstantiationService(services)
  const contrib = inst.createInstance(HistoryContribution)
  return {
    historyService,
    contextKeyService,
    inst,
    contrib,
    setActiveEditor: editor.setActive,
    swapWorkspaceScope: storage.swapWorkspaceScope,
  }
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

  it('records on active editor change so GoBack works after open-a then open-b without cursor movement', () => {
    const { historyService, inst, setActiveEditor } = setup()
    const inputA = inst.createInstance(FileEditorInput, URI.file('/a.ts'))
    const inputB = inst.createInstance(FileEditorInput, URI.file('/b.ts'))
    setActiveEditor(inputA)
    setActiveEditor(inputB)
    expect(historyService.canGoBack()).toBe(true)
    const stack = historyService.getBackStack()
    expect(stack.map((e) => e.resource.fsPath)).toEqual([
      URI.file('/a.ts').fsPath,
      URI.file('/b.ts').fsPath,
    ])
  })

  it('clears history when the workspace scope swaps', () => {
    const { historyService, setActiveEditor, swapWorkspaceScope, inst } = setup()
    const inputA = inst.createInstance(FileEditorInput, URI.file('/a.ts'))
    const inputB = inst.createInstance(FileEditorInput, URI.file('/b.ts'))
    setActiveEditor(inputA)
    setActiveEditor(inputB)
    expect(historyService.canGoBack()).toBe(true)

    swapWorkspaceScope()
    expect(historyService.getBackStack().length).toBe(0)
    expect(historyService.canGoBack()).toBe(false)
  })

  it('records a same-named file freshly after a workspace swap (dedup closure reset)', () => {
    const { historyService, setActiveEditor, swapWorkspaceScope, inst } = setup()
    const before = inst.createInstance(FileEditorInput, URI.file('/a.ts'))
    setActiveEditor(before)
    swapWorkspaceScope()
    expect(historyService.getBackStack().length).toBe(0)
    // Same URI string, new workspace — must be recorded, not deduped away.
    const after = inst.createInstance(FileEditorInput, URI.file('/a.ts'))
    setActiveEditor(after)
    expect(historyService.getBackStack().length).toBe(1)
  })

  it('records non-file editor inputs with typeId + serialized so GoBack can rebuild them', () => {
    const { historyService, setActiveEditor } = setup()

    class FakeSettingsInput extends ImportedEditorInput {
      static readonly TYPE_ID = 'settings'
      override get typeId() {
        return FakeSettingsInput.TYPE_ID
      }
      override get resource() {
        return URI.from({ scheme: 'universe', path: '/settings' })
      }
      override getName() {
        return 'Settings'
      }
      override serialize() {
        return JSON.stringify({ target: 1 })
      }
    }

    setActiveEditor(new FakeSettingsInput())

    const stack = historyService.getBackStack()
    expect(stack).toHaveLength(1)
    expect(stack[0]?.typeId).toBe(FakeSettingsInput.TYPE_ID)
    expect(stack[0]?.serialized).toBe(JSON.stringify({ target: 1 }))
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
    const editorA = makeFakeEditor(uriA)
    FileEditorRegistry.register(
      inputA,
      editorA as unknown as Parameters<typeof FileEditorRegistry.register>[1],
    )
    editorA.position = { lineNumber: 5, column: 1 }
    editorA.triggerCursor()
    vi.advanceTimersByTime(300)

    // Switching tabs in production mounts a fresh Monaco instance for B —
    // not the same instance with a swapped model.
    const uriB = URI.file('/b.ts')
    const inputB = inst.createInstance(FileEditorInput, uriB)
    const editorB = makeFakeEditor(uriB)
    FileEditorRegistry.register(
      inputB,
      editorB as unknown as Parameters<typeof FileEditorRegistry.register>[1],
    )
    editorB.position = { lineNumber: 5, column: 1 }
    editorB.triggerCursor()
    vi.advanceTimersByTime(300)

    expect(historyService.getBackStack().length).toBe(2)
    expect(historyService.getBackStack()[1]?.resource.fsPath).toBe(URI.file('/b.ts').fsPath)
  })

  it('captures the leaving editor’s final cursor on a sub-threshold move when switching away', () => {
    // Repro: cursor 1→2 in A (delta below threshold), switch to B before the
    // 250ms debounce fires. GoBack must return to A@2, so A's stack entry has
    // to carry the final caret — not the selection-less placeholder recorded on
    // entry.
    const { historyService, inst, setActiveEditor } = setup()
    const uriA = URI.file('/a.ts')
    const inputA = inst.createInstance(FileEditorInput, uriA)
    const editorA = makeFakeEditor(uriA)
    setActiveEditor(inputA)
    FileEditorRegistry.register(
      inputA,
      editorA as unknown as Parameters<typeof FileEditorRegistry.register>[1],
    )
    editorA.position = { lineNumber: 2, column: 3 }
    editorA.triggerCursor()

    // Switch to B before the debounce window elapses.
    const inputB = inst.createInstance(FileEditorInput, URI.file('/b.ts'))
    setActiveEditor(inputB)

    const aEntry = historyService.getBackStack().find((e) => e.resource.fsPath === uriA.fsPath)
    expect(aEntry?.selection?.startLine).toBe(2)
    expect(aEntry?.selection?.startColumn).toBe(3)
  })

  it('cancels the leaving editor’s pending flush so a late fire cannot corrupt the stack', () => {
    // Without cancellation the debounced flush for A lands AFTER B was recorded
    // and pushes a third, out-of-order [A, B, A] entry.
    const { historyService, inst, setActiveEditor } = setup()
    const uriA = URI.file('/a.ts')
    const inputA = inst.createInstance(FileEditorInput, uriA)
    const editorA = makeFakeEditor(uriA)
    setActiveEditor(inputA)
    FileEditorRegistry.register(
      inputA,
      editorA as unknown as Parameters<typeof FileEditorRegistry.register>[1],
    )
    editorA.position = { lineNumber: 2, column: 1 }
    editorA.triggerCursor()

    const inputB = inst.createInstance(FileEditorInput, URI.file('/b.ts'))
    setActiveEditor(inputB)

    // Any pending A timer must have been cancelled / folded in on the switch.
    vi.advanceTimersByTime(300)

    expect(historyService.getBackStack().map((e) => e.resource.fsPath)).toEqual([
      uriA.fsPath,
      URI.file('/b.ts').fsPath,
    ])
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

  it('rebinds the resource when a preview slot reuses the same Monaco instance for a new file', () => {
    const { historyService, inst } = setup()
    const uriA = URI.file('/a.ts')
    const inputA = inst.createInstance(FileEditorInput, uriA)
    const editor = makeFakeEditor(uriA)
    FileEditorRegistry.register(
      inputA,
      editor as unknown as Parameters<typeof FileEditorRegistry.register>[1],
    )
    editor.position = { lineNumber: 30, column: 1 }
    editor.triggerCursor()
    vi.advanceTimersByTime(300)
    expect(historyService.getBackStack().map((e) => e.resource.fsPath)).toEqual([uriA.fsPath])

    // Preview-replace reuses the SAME Monaco instance, re-registering it under b.
    const uriB = URI.file('/b.ts')
    const inputB = inst.createInstance(FileEditorInput, uriB)
    FileEditorRegistry.register(
      inputB,
      editor as unknown as Parameters<typeof FileEditorRegistry.register>[1],
    )
    editor.position = { lineNumber: 5, column: 1 }
    editor.triggerCursor()
    vi.advanceTimersByTime(300)

    // The cursor move now belongs to b — it must not be recorded against stale a.
    const stack = historyService.getBackStack()
    expect(stack[stack.length - 1]?.resource.fsPath).toBe(uriB.fsPath)
    expect(stack.some((e, i) => i > 0 && e.resource.fsPath === uriA.fsPath)).toBe(false)
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
