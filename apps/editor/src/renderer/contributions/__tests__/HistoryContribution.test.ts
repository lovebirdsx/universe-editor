/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ContextKeyService,
  EditorInput as ImportedEditorInput,
  Emitter,
  ICommandService,
  IContextKeyService,
  IEditorGroupsService,
  IEditorService,
  IFileService,
  IHistoryService,
  IStorageService,
  IUriIdentityService,
  InstantiationService,
  ServiceCollection,
  URI,
  UriIdentityService,
  derived,
  observableValue,
  type IEditorInput,
  type ICommandService as ICommandServiceType,
  type IEditorService as IEditorServiceType,
  type IFileService as IFileServiceType,
  type IStorageService as IStorageServiceType,
} from '@universe-editor/platform'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import { HistoryService } from '../../services/history/HistoryService.js'
import { HistoryContribution } from '../HistoryContribution.js'

// The contribution registers its open handler through MonacoLoader; capture it
// here so tests can drive the real registration path without loading monaco.
const openHandlerState = vi.hoisted(() => ({
  handler: null as null | ((input: unknown, source: unknown) => Promise<unknown>),
}))

vi.mock('../../workbench/editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: {
    registerCodeEditorOpenHandler(handler: unknown) {
      openHandlerState.handler = handler as never
      return Promise.resolve({ dispose() {} })
    },
  },
}))

interface FakeSelection {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

interface FakeMonacoEditor {
  position: { lineNumber: number; column: number }
  selection: FakeSelection | null
  uri: URI
  cursorEmitter: Emitter<void>
  disposeEmitter: Emitter<void>
  onDidChangeCursorPosition(cb: () => void): { dispose(): void }
  onDidDispose(cb: () => void): { dispose(): void }
  getPosition(): { lineNumber: number; column: number } | null
  getSelection(): FakeSelection | null
  getModel(): { uri: URI } | null
  triggerCursor(): void
  triggerDispose(): void
}

function makeFakeEditor(uri: URI): FakeMonacoEditor {
  const cursorEmitter = new Emitter<void>()
  const disposeEmitter = new Emitter<void>()
  const m: FakeMonacoEditor = {
    position: { lineNumber: 1, column: 1 },
    selection: null,
    uri,
    cursorEmitter,
    disposeEmitter,
    onDidChangeCursorPosition: (cb) => cursorEmitter.event(cb),
    onDidDispose: (cb) => disposeEmitter.event(cb),
    getPosition() {
      return m.position
    },
    getSelection() {
      return m.selection
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
    async readFileHead() {
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

function makeFakeCommandService(): ICommandServiceType {
  return {
    _serviceBrand: undefined,
    executeCommand: vi.fn(async () => undefined),
  }
}

const activeContributions: HistoryContribution[] = []

function setup() {
  FileEditorRegistry._resetForTests()
  const services = new ServiceCollection()
  services.set(IFileService, makeFileService())
  const contextKeyService = new ContextKeyService()
  services.set(IContextKeyService, contextKeyService)
  const uriIdentity = new UriIdentityService('linux')
  services.set(IUriIdentityService, uriIdentity)
  services.set(IEditorGroupsService, new EditorGroupsService())
  const historyService = new HistoryService(uriIdentity)
  services.set(IHistoryService, historyService)
  const editor = makeFakeEditorService()
  services.set(IEditorService, editor.service)
  const storage = makeFakeStorageService()
  services.set(IStorageService, storage.service)
  services.set(ICommandService, makeFakeCommandService())
  const inst = new InstantiationService(services)
  const contrib = inst.createInstance(HistoryContribution)
  activeContributions.push(contrib)
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
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    FileEditorRegistry._resetForTests()
  })
  afterEach(() => {
    for (const contrib of activeContributions.splice(0)) contrib.dispose()
    vi.useRealTimers()
    vi.unstubAllGlobals()
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

  it('GoBack returns to the jump origin B after a small A→B move then a definition jump (same file)', () => {
    // Repro: caret at symbol A (line 5), small move to symbol B (line 8, delta
    // 3 <= threshold), then "go to definition" jumps to line 50 (same file).
    // GoBack must land on B (line 8) — the spot the jump began — not on A.
    const { historyService, inst } = setup()
    const uri = URI.file('/a.ts')
    const input = inst.createInstance(FileEditorInput, uri)
    const editor = makeFakeEditor(uri)
    FileEditorRegistry.register(
      input,
      editor as unknown as Parameters<typeof FileEditorRegistry.register>[1],
    )

    // Caret at A.
    editor.position = { lineNumber: 5, column: 1 }
    editor.triggerCursor()
    vi.advanceTimersByTime(300)

    // Small move to B (delta 3, below the significance threshold).
    editor.position = { lineNumber: 8, column: 1 }
    editor.triggerCursor()
    vi.advanceTimersByTime(300)

    // Go to definition jumps far away (same file).
    editor.position = { lineNumber: 50, column: 1 }
    editor.triggerCursor()
    vi.advanceTimersByTime(300)

    const target = historyService.goBack()
    expect(target?.selection?.startLine).toBe(8)
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

  it('records jump origin and target when an open handler lands a selection (same file)', async () => {
    const { historyService, inst } = setup()
    const uri = URI.file('/a.ts')
    const input = inst.createInstance(FileEditorInput, uri)
    const editor = makeFakeEditor(uri)
    FileEditorRegistry.register(
      input,
      editor as unknown as Parameters<typeof FileEditorRegistry.register>[1],
    )
    editor.position = { lineNumber: 11, column: 5 }
    editor.selection = { startLineNumber: 11, startColumn: 5, endLineNumber: 11, endColumn: 5 }

    const handler = openHandlerState.handler
    expect(handler).not.toBeNull()
    await handler?.(
      {
        resource: { toString: () => uri.toString() },
        options: {
          selection: { startLineNumber: 25, startColumn: 10, endLineNumber: 25, endColumn: 10 },
        },
      },
      editor,
    )

    const stack = historyService.getBackStack()
    expect(stack.length).toBe(2)
    expect(stack[0]?.selection?.startLine).toBe(11)
    expect(stack[0]?.selection?.startColumn).toBe(5)
    expect(stack[1]?.selection?.startLine).toBe(25)
    expect(stack[1]?.selection?.startColumn).toBe(10)
    // The origin sits below the target: goBack lands back on the jump origin.
    expect(historyService.goBack()?.selection?.startLine).toBe(11)
  })

  it('a short same-file jump (delta 3) still produces origin and target entries', async () => {
    const { historyService, inst } = setup()
    const uri = URI.file('/a.ts')
    const input = inst.createInstance(FileEditorInput, uri)
    const editor = makeFakeEditor(uri)
    FileEditorRegistry.register(
      input,
      editor as unknown as Parameters<typeof FileEditorRegistry.register>[1],
    )
    editor.position = { lineNumber: 20, column: 1 }

    const handler = openHandlerState.handler
    expect(handler).not.toBeNull()
    await handler?.(
      {
        resource: { toString: () => uri.toString() },
        options: {
          selection: { startLineNumber: 23, startColumn: 1, endLineNumber: 23, endColumn: 1 },
        },
      },
      editor,
    )

    const stack = historyService.getBackStack()
    expect(stack.length).toBe(2)
    expect(stack[0]?.selection?.startLine).toBe(20)
    expect(stack[1]?.selection?.startLine).toBe(23)
  })

  it('flushes the active editor pending move synchronously when goBack fires onWillNavigate', () => {
    const { historyService, inst, setActiveEditor } = setup()
    const uri = URI.file('/a.ts')
    const input = inst.createInstance(FileEditorInput, uri)
    setActiveEditor(input)
    const editor = makeFakeEditor(uri)
    FileEditorRegistry.register(
      input,
      editor as unknown as Parameters<typeof FileEditorRegistry.register>[1],
    )
    editor.position = { lineNumber: 5, column: 1 }
    editor.triggerCursor()
    vi.advanceTimersByTime(300) // first flush records 5

    // A significant move whose debounce has not fired yet.
    editor.position = { lineNumber: 50, column: 1 }
    editor.triggerCursor()

    // goBack fires onWillNavigate -> the pending 50 is flushed synchronously and
    // becomes the "current" entry; the pop then lands on 5, not on a stale top.
    const target = historyService.goBack()
    expect(target?.selection?.startLine).toBe(5)
    expect(historyService.getBackStack()[0]?.selection?.startLine).toBe(5)
    expect(historyService.getForwardStack()[0]?.selection?.startLine).toBe(50)

    // The pending timer was cancelled by the flush: nothing fires later.
    const backLength = historyService.getBackStack().length
    const forwardLength = historyService.getForwardStack().length
    vi.advanceTimersByTime(300)
    expect(historyService.getBackStack().length).toBe(backLength)
    expect(historyService.getForwardStack().length).toBe(forwardLength)
  })

  it('records the full selection range on flush and on leaving an editor', () => {
    const { historyService, inst, setActiveEditor } = setup()
    const uri = URI.file('/a.ts')
    const input = inst.createInstance(FileEditorInput, uri)
    setActiveEditor(input)
    const editor = makeFakeEditor(uri)
    FileEditorRegistry.register(
      input,
      editor as unknown as Parameters<typeof FileEditorRegistry.register>[1],
    )
    editor.selection = { startLineNumber: 10, startColumn: 3, endLineNumber: 12, endColumn: 7 }
    editor.position = { lineNumber: 12, column: 7 }
    editor.triggerCursor()
    vi.advanceTimersByTime(300)

    expect(historyService.getBackStack()[0]?.selection).toEqual({
      startLine: 10,
      startColumn: 3,
      endLine: 12,
      endColumn: 7,
    })

    // Switching away folds the leaving editor's full selection into its entry.
    const inputB = inst.createInstance(FileEditorInput, URI.file('/b.ts'))
    setActiveEditor(inputB)
    const aEntry = historyService.getBackStack().find((e) => e.resource.fsPath === uri.fsPath)
    expect(aEntry?.selection).toEqual({ startLine: 10, startColumn: 3, endLine: 12, endColumn: 7 })
  })

  it('measures significance at the caret, so an upward drag selection still records', () => {
    const { historyService, inst } = setup()
    const uri = URI.file('/a.ts')
    const input = inst.createInstance(FileEditorInput, uri)
    const editor = makeFakeEditor(uri)
    FileEditorRegistry.register(
      input,
      editor as unknown as Parameters<typeof FileEditorRegistry.register>[1],
    )
    editor.position = { lineNumber: 30, column: 1 }
    editor.triggerCursor()
    vi.advanceTimersByTime(300)
    expect(historyService.getBackStack().length).toBe(1)

    // Drag-select upward from line 30 to line 5: the selection range is 5..30
    // (directionless) while the caret — the active end — moved to line 5.
    // Significance must follow the caret; anchoring on endLine would read this
    // 25-line move as a zero-length one and swallow it.
    editor.selection = { startLineNumber: 5, startColumn: 1, endLineNumber: 30, endColumn: 1 }
    editor.position = { lineNumber: 5, column: 1 }
    editor.triggerCursor()
    vi.advanceTimersByTime(300)

    const stack = historyService.getBackStack()
    expect(stack.length).toBe(2)
    expect(stack[1]?.selection).toEqual({ startLine: 5, startColumn: 1, endLine: 30, endColumn: 1 })
  })
})
