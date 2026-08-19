/**
 * whenOpened() backs the did-save pipeline's ordering guarantee: a Save-As
 * notification must not reach the host before the replacement document's open
 * push, because the host drops saves for URIs it has never seen open.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  Event,
  URI,
  constObservable,
  type IEditorService,
  type ILoggerService,
  type IWorkspaceService,
} from '@universe-editor/platform'
import { DocumentSyncContribution } from '../DocumentSyncContribution.js'
import type { IExtensionHostClientService } from '../../services/extensions/ExtensionHostClientService.js'
import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'

const RESOURCE = URI.file('/ws/a.txt')
const MODEL_URI_STRING = 'file:///ws/a.txt'

function fakeModel(uriString = MODEL_URI_STRING) {
  const willDispose = new Emitter<void>()
  let disposed = false
  return {
    uri: URI.parse(uriString),
    getValue: () => 'hello',
    getVersionId: () => 1,
    getLanguageId: () => 'plaintext',
    isDisposed: () => disposed,
    onDidChangeContent: Event.None,
    onDidChangeLanguage: Event.None,
    onWillDispose: willDispose.event,
    dispose: () => {
      disposed = true
      willDispose.fire()
      willDispose.dispose()
    },
  } as unknown as monaco.editor.ITextModel
}

const stubEditorService = {
  activeEditor: constObservable(undefined),
} as unknown as IEditorService
const stubWorkspace = {
  onDidChangeWorkspace: Event.None,
} as unknown as IWorkspaceService
const stubLoggerService = {
  createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
} as unknown as ILoggerService

function fakeDocuments() {
  return {
    $acceptDocumentOpen: vi.fn().mockResolvedValue(undefined),
    $acceptDocumentChange: vi.fn().mockResolvedValue(undefined),
    $acceptDocumentClose: vi.fn().mockResolvedValue(undefined),
  }
}

describe('DocumentSyncContribution.whenOpened', () => {
  let contribution: DocumentSyncContribution | undefined

  afterEach(() => {
    contribution?.dispose()
    contribution = undefined
  })

  function setup() {
    const documents = fakeDocuments()
    const client = {
      getDocuments: () => documents,
      activateByEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as IExtensionHostClientService
    contribution = new DocumentSyncContribution(
      stubEditorService,
      stubWorkspace,
      client,
      stubLoggerService,
    )
    return { documents }
  }

  it('resolves true immediately once the document is open', async () => {
    const { documents } = setup()
    contribution!.trackModel(RESOURCE, fakeModel())
    await vi.waitFor(() => expect(documents.$acceptDocumentOpen).toHaveBeenCalledTimes(1))
    await expect(contribution!.whenOpened(RESOURCE)).resolves.toBe(true)
  })

  it('waits for the open push of a document that attaches later', async () => {
    const { documents } = setup()
    let settled: boolean | undefined
    const pending = contribution!.whenOpened(RESOURCE).then((v) => {
      settled = v
    })
    contribution!.trackModel(RESOURCE, fakeModel())
    expect(settled).toBeUndefined()
    await pending
    expect(settled).toBe(true)
    expect(documents.$acceptDocumentOpen).toHaveBeenCalledTimes(1)
  })

  it('resolves false on timeout when the document never attaches', async () => {
    setup()
    await expect(contribution!.whenOpened(RESOURCE, 20)).resolves.toBe(false)
  })

  it('resolves false when the pipeline is disposed before the open lands', async () => {
    setup()
    const pending = contribution!.whenOpened(RESOURCE, 60_000)
    contribution!.dispose()
    contribution = undefined
    await expect(pending).resolves.toBe(false)
  })

  it('resolves false when the tracked document detaches before its open lands', async () => {
    // No documents channel: _openDoc bails out before the open push, so the
    // entry never becomes opened; disposing the model detaches it.
    const client = {
      getDocuments: () => undefined,
      activateByEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as IExtensionHostClientService
    contribution = new DocumentSyncContribution(
      stubEditorService,
      stubWorkspace,
      client,
      stubLoggerService,
    )
    const model = fakeModel()
    contribution!.trackModel(RESOURCE, model)
    // Let the in-flight _openDoc reach its documents-less early return first.
    await new Promise((r) => setTimeout(r, 10))
    const pending = contribution!.whenOpened(RESOURCE, 60_000)
    model.dispose()
    await expect(pending).resolves.toBe(false)
  })
})
