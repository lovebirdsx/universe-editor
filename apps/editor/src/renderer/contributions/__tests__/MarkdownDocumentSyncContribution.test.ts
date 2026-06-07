/*---------------------------------------------------------------------------------------------
 *  Regression test for MarkdownDocumentSyncContribution — guards the per-document
 *  DisposableStore created in `_attach` against leaking. The store must be rooted
 *  under the contribution (whose chain ends at the singleton workbenchStore), so
 *  that when the owner stays alive but is never disposed (the beforeunload case),
 *  the leak tracker does not report it. Mirrors lifecycle.test.ts' "alive owner
 *  rooted at a singleton" scenario.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DisposableStore,
  DisposableTracker,
  Emitter,
  IEditorService,
  IFileService,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  URI,
  markAsSingleton,
  observableValue,
  setDisposableTracker,
  toDisposable,
  type IEditorInput,
  type IFileService as IFileServiceType,
  type IWorkspace,
} from '@universe-editor/platform'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import { type monaco } from '../../workbench/editor/monaco/MonacoLoader.js'
import { IMarkdownLanguageService } from '../../../shared/ipc/markdownLanguageService.js'
import { MarkdownDocumentSyncContribution } from '../MarkdownDocumentSyncContribution.js'

vi.mock('../../workbench/editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: {
    get: () => ({ editor: { setModelMarkers: () => {} } }),
  },
}))

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

function makeEditorService(active: ReturnType<typeof observableValue<IEditorInput | undefined>>) {
  return {
    _serviceBrand: undefined,
    openEditor() {},
    closeEditor() {},
    closeAllEditors() {},
    openEditors: observableValue<readonly IEditorInput[]>('open', []),
    activeEditorId: observableValue<string | undefined>('id', undefined),
    activeEditor: active,
  } as unknown as IEditorService
}

function makeWorkspaceService() {
  return {
    _serviceBrand: undefined,
    current: { folder: URI.file('/ws'), name: 'Test' } as IWorkspace,
    onDidChangeWorkspace: new Emitter<IWorkspace | null>().event,
    recent: [],
    onDidChangeRecent: new Emitter<readonly never[]>().event,
    whenReady: Promise.resolve(),
    async openFolder() {},
    async closeFolder() {},
    async removeRecent() {},
    async clearRecent() {},
  } as unknown as IWorkspaceService
}

function makeMarkdownService(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    _serviceBrand: undefined,
    onDidRestart: new Emitter<void>().event,
    ensureStarted: vi.fn().mockResolvedValue(undefined),
    didOpen: vi.fn().mockResolvedValue(undefined),
    didChange: vi.fn().mockResolvedValue(undefined),
    didClose: vi.fn().mockResolvedValue(undefined),
    provideDiagnostics: vi.fn().mockResolvedValue([]),
    provideDocumentSymbols: vi.fn().mockResolvedValue([]),
    provideDefinition: vi.fn().mockResolvedValue([]),
    provideReferences: vi.fn().mockResolvedValue([]),
    provideWorkspaceSymbols: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as IMarkdownLanguageService
}

/** Minimal Monaco model stub. Events are plain functions (no Emitter object) so
 *  the stub itself contributes no orphan disposables to the tracker. */
function makeModel(resource: URI): monaco.editor.ITextModel {
  return {
    uri: resource.toJSON(),
    isDisposed: () => false,
    getVersionId: () => 1,
    getValue: () => '# Test',
    onDidChangeContent: (_l: unknown) => toDisposable(() => {}),
    onWillDispose: (_l: unknown) => toDisposable(() => {}),
  } as unknown as monaco.editor.ITextModel
}

describe('MarkdownDocumentSyncContribution', () => {
  beforeEach(() => FileEditorRegistry._resetForTests())
  afterEach(() => {
    FileEditorRegistry._resetForTests()
    setDisposableTracker(null)
  })

  it('does not leak the per-document store when the owner stays alive under a singleton', () => {
    // Build all "noise" before installing the tracker so only the work done during
    // _attach is observed.
    const services = new ServiceCollection()
    services.set(IFileService, makeFileService())
    const inst = new InstantiationService(services)
    const input = inst.createInstance(FileEditorInput, URI.file('/ws/test.md'))
    const model = makeModel(input.resource)
    const fakeEditor = { getModel: () => model } as unknown as Parameters<
      typeof FileEditorRegistry.register
    >[1]

    const active = observableValue<IEditorInput | undefined>('active', undefined)
    const editorService = makeEditorService(active)
    const workspaceService = makeWorkspaceService()
    // ensureStarted never resolves: keeps _attach's async tail (didOpen / diagnostics
    // → MonacoLoader) from running so the test stays synchronous and DOM-free.
    const mdService = makeMarkdownService({
      ensureStarted: vi.fn(() => new Promise<void>(() => {})),
    })

    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)

    const root = markAsSingleton(new DisposableStore())
    try {
      const contrib = new MarkdownDocumentSyncContribution(
        editorService,
        workspaceService,
        mdService,
      )
      root.add(contrib)
      root.add(input)

      active.set(input, undefined) // no model registered yet → _sync early-returns
      FileEditorRegistry.register(input, fakeEditor) // → onDidChange → _sync → _attach

      expect(tracker.computeLeakingDisposables()).toBeUndefined()
    } finally {
      root.dispose()
    }
  })

  it('pushes the document to the server on attach', async () => {
    const services = new ServiceCollection()
    services.set(IFileService, makeFileService())
    const inst = new InstantiationService(services)
    const input = inst.createInstance(FileEditorInput, URI.file('/ws/test.md'))
    const model = makeModel(input.resource)
    const fakeEditor = { getModel: () => model } as unknown as Parameters<
      typeof FileEditorRegistry.register
    >[1]

    const active = observableValue<IEditorInput | undefined>('active', undefined)
    // provideDiagnostics hangs so the flow stops before MonacoLoader.get().
    const mdService = makeMarkdownService({
      provideDiagnostics: vi.fn(() => new Promise(() => {})),
    })
    const contrib = new MarkdownDocumentSyncContribution(
      makeEditorService(active),
      makeWorkspaceService(),
      mdService,
    )

    try {
      active.set(input, undefined)
      FileEditorRegistry.register(input, fakeEditor)
      await new Promise((r) => setTimeout(r, 0))

      expect((mdService.ensureStarted as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
      expect((mdService.didOpen as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    } finally {
      contrib.dispose()
    }
  })
})
