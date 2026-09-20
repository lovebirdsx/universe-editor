/**
 * DocumentSyncContribution 各套用例共用的假件：文本、版本与变更事件都由用例手动驱动的模型，以及
 * 发送可以被挂住的 documents 代理（积压上限要守的正是宿主慢的形状）。
 *
 * 变更的行列由模型文本推出来（多用例用的单行模型恒为第 1 行）；这些用例断言的是载荷大小、顺序与
 * 版本，从不涉及行号。
 */
import { Emitter, URI, constObservable } from '@universe-editor/platform'
import { vi } from 'vitest'
import type { IEditorService, ILoggerService, IWorkspaceService } from '@universe-editor/platform'
import { DocumentSyncContribution } from '../DocumentSyncContribution.js'
import type { IExtensionHostClientService } from '../../services/extensions/ExtensionHostClientService.js'
import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'

export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error?: unknown): void
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Let every already-scheduled continuation run. Timers are not advanced. */
export async function settle(turns = 24): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve()
}

export interface FakeModel {
  readonly model: monaco.editor.ITextModel
  /** The text the model would report right now. */
  text(): string
  version(): number
  /** Replace `deleted` code units at `offset` with `text`: one change event, version + 1. */
  edit(offset: number, deleted: number, text: string): void
  /** Wholesale reset (`setValue` / file reload): a flush event carrying no delta. */
  reset(text: string): void
  setLanguage(languageId: string): void
  dispose(): void
  /** How many times the sync path read the whole text — the cap must add none. */
  fullReads(): number
}

export function fakeModel(uriString: string, text: string, languageId = 'plaintext'): FakeModel {
  const willDispose = new Emitter<void>()
  const didChange = new Emitter<unknown>()
  const didChangeLanguage = new Emitter<{ oldLanguage: string; newLanguage: string }>()
  let value = text
  let currentVersion = 1
  let language = languageId
  let disposed = false
  let reads = 0
  let multiLine = text.includes('\n')

  const positionOf = (offset: number): { line: number; column: number } => {
    if (!multiLine) return { line: 1, column: offset + 1 }
    let line = 1
    let lineStart = 0
    for (let i = 0; i < offset && i < value.length; i++) {
      if (value.charCodeAt(i) === 10) {
        line++
        lineStart = i + 1
      }
    }
    return { line, column: offset - lineStart + 1 }
  }

  const model = {
    uri: URI.parse(uriString),
    getValue: () => {
      reads++
      return value
    },
    getValueLength: () => value.length,
    getVersionId: () => currentVersion,
    getLanguageId: () => language,
    isDisposed: () => disposed,
    onDidChangeContent: didChange.event,
    onDidChangeLanguage: didChangeLanguage.event,
    onWillDispose: willDispose.event,
  }

  return {
    model: model as unknown as monaco.editor.ITextModel,
    text: () => value,
    version: () => currentVersion,
    edit: (offset, deleted, inserted) => {
      if (disposed) return
      const start = positionOf(offset)
      const end = positionOf(offset + deleted)
      value = value.slice(0, offset) + inserted + value.slice(offset + deleted)
      multiLine = multiLine || inserted.includes('\n')
      currentVersion++
      didChange.fire({
        isFlush: false,
        versionId: currentVersion,
        changes: [
          {
            range: {
              startLineNumber: start.line,
              startColumn: start.column,
              endLineNumber: end.line,
              endColumn: end.column,
            },
            rangeOffset: offset,
            rangeLength: deleted,
            text: inserted,
          },
        ],
      })
    },
    reset: (next) => {
      if (disposed) return
      value = next
      multiLine = next.includes('\n')
      currentVersion++
      didChange.fire({ isFlush: true, versionId: currentVersion, changes: [] })
    },
    setLanguage: (next) => {
      if (disposed || next === language) return
      const old = language
      language = next
      didChangeLanguage.fire({ oldLanguage: old, newLanguage: next })
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      willDispose.fire()
      willDispose.dispose()
      didChange.dispose()
      didChangeLanguage.dispose()
    },
    fullReads: () => reads,
  }
}

export type FakeDocuments = {
  $acceptDocumentOpen: ReturnType<typeof vi.fn>
  $acceptDocumentChange: ReturnType<typeof vi.fn>
  $acceptDocumentClose: ReturnType<typeof vi.fn>
}

/** A documents proxy; tests override individual methods to hold a send open. */
export function fakeDocuments(): FakeDocuments {
  return {
    $acceptDocumentOpen: vi.fn(async () => undefined),
    $acceptDocumentChange: vi.fn(async () => undefined),
    $acceptDocumentClose: vi.fn(async () => undefined),
  }
}

export interface DocumentSyncHarness {
  readonly contribution: DocumentSyncContribution
  /** The live documents proxy — swapped by setDocuments() to model a relaunch. */
  readonly documents: FakeDocuments
  readonly client: {
    getDocuments(): FakeDocuments | undefined
    activateByEvent: ReturnType<typeof vi.fn>
  }
  readonly logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }
  /** Languages activated by the pipeline, in order. */
  readonly activated: string[]
  /** A new host generation: the old proxy is gone and the mirror with it. */
  setDocuments(next: FakeDocuments): void
  /** The host goes away (crash, restart window) until the next setDocuments(). */
  dropHost(): void
  fireWorkspaceChange(): void
}

export function setupDocumentSync(): DocumentSyncHarness {
  let documents: FakeDocuments | undefined = fakeDocuments()
  const workspaceChange = new Emitter<unknown>()
  const logger = { info: vi.fn(), warn: vi.fn() }
  const activated: string[] = []
  const client = {
    getDocuments: () => documents,
    activateByEvent: vi.fn(async (event: string) => {
      activated.push(event)
      return undefined
    }),
  }
  const editorService = { activeEditor: constObservable(undefined) } as unknown as IEditorService
  const workspace = {
    onDidChangeWorkspace: workspaceChange.event,
  } as unknown as IWorkspaceService
  const loggerService = { createLogger: () => logger } as unknown as ILoggerService

  const contribution = new DocumentSyncContribution(
    editorService,
    workspace,
    client as unknown as IExtensionHostClientService,
    loggerService,
  )

  return {
    contribution,
    get documents() {
      // Tests read this while the host is up; dropHost() is what takes it away.
      return documents as FakeDocuments
    },
    client,
    logger,
    activated,
    setDocuments: (next) => {
      documents = next
    },
    dropHost: () => {
      documents = undefined
    },
    fireWorkspaceChange: () => workspaceChange.fire(null),
  }
}
