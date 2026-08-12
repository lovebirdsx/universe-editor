/**
 * Untitled documents mirror like file ones (VSCode parity): `trackModel` with an
 * `untitled:` resource pushes `$acceptDocumentOpen`, and disposing the model —
 * which is how Save-As ends the untitled buffer's identity — pushes
 * `$acceptDocumentClose`. The save-as ordering (close before the new file's
 * open) is what lets the host drop the dead untitled buffer before the did-save
 * for the picked file arrives.
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

const UNTITLED_RESOURCE = URI.from({ scheme: 'untitled', path: '/Untitled-1' })
const UNTITLED_URI_STRING = 'untitled:/Untitled-1'
const FILE_RESOURCE = URI.file('/ws/saved.txt')
const FILE_URI_STRING = 'file:///ws/saved.txt'

function fakeModel(uriString: string, text: string, languageId = 'plaintext') {
  const willDispose = new Emitter<void>()
  const didChange = new Emitter<{ changes: readonly unknown[]; isFlush?: boolean }>()
  let disposed = false
  let value = text
  return {
    uri: URI.parse(uriString),
    getValue: () => value,
    getVersionId: () => 1,
    getLanguageId: () => languageId,
    isDisposed: () => disposed,
    onDidChangeContent: didChange.event,
    onWillDispose: willDispose.event,
    setValue: (next: string) => {
      value = next
      didChange.fire({ changes: [], isFlush: true })
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      willDispose.fire()
      willDispose.dispose()
      didChange.dispose()
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

describe('DocumentSyncContribution untitled documents', () => {
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

  it('pushes an open for a tracked untitled model with its language', async () => {
    const { documents } = setup()
    contribution!.trackModel(UNTITLED_RESOURCE, fakeModel(UNTITLED_URI_STRING, 'abc', 'markdown'))
    await vi.waitFor(() => expect(documents.$acceptDocumentOpen).toHaveBeenCalledTimes(1))
    const [uri, languageId, , text] = documents.$acceptDocumentOpen.mock.calls[0]!
    expect(uri.toString()).toBe(UNTITLED_URI_STRING)
    expect(languageId).toBe('markdown')
    expect(text).toBe('abc')
  })

  it('pushes close when the untitled model is disposed', async () => {
    const { documents } = setup()
    const model = fakeModel(UNTITLED_URI_STRING, 'abc')
    contribution!.trackModel(UNTITLED_RESOURCE, model)
    await vi.waitFor(() => expect(documents.$acceptDocumentOpen).toHaveBeenCalledTimes(1))
    model.dispose()
    await vi.waitFor(() => expect(documents.$acceptDocumentClose).toHaveBeenCalledTimes(1))
    expect(documents.$acceptDocumentClose.mock.calls[0]![0].toString()).toBe(UNTITLED_URI_STRING)
  })

  it('mirrors content changes of an untitled model to the host', async () => {
    const { documents } = setup()
    const model = fakeModel(UNTITLED_URI_STRING, 'abc')
    contribution!.trackModel(UNTITLED_RESOURCE, model)
    await vi.waitFor(() => expect(documents.$acceptDocumentOpen).toHaveBeenCalledTimes(1))
    model.setValue('abc def')
    // Changes ride the debounced push; a flush (isFlush here, empty delta) sends
    // the full current text.
    await vi.waitFor(() => expect(documents.$acceptDocumentChange).toHaveBeenCalled())
    const [uri, , changes] = documents.$acceptDocumentChange.mock.calls[0]!
    expect(uri.toString()).toBe(UNTITLED_URI_STRING)
    expect(changes[0]?.text).toBe('abc def')
  })

  it('Save-As pushes close(untitled) before the replacement file opens', async () => {
    const { documents } = setup()
    const order: string[] = []
    documents.$acceptDocumentOpen.mockImplementation((uri: URI) => {
      order.push(`open:${uri.toString()}`)
      return Promise.resolve()
    })
    documents.$acceptDocumentClose.mockImplementation((uri: URI) => {
      order.push(`close:${uri.toString()}`)
      return Promise.resolve()
    })

    // The untitled buffer is mirrored.
    const untitledModel = fakeModel(UNTITLED_URI_STRING, 'body')
    contribution!.trackModel(UNTITLED_RESOURCE, untitledModel)
    await vi.waitFor(() => expect(documents.$acceptDocumentOpen).toHaveBeenCalledTimes(1))

    // Save-As: the untitled model is force-disposed (closing it), then the new
    // file model is tracked (opening it).
    untitledModel.dispose()
    contribution!.trackModel(FILE_RESOURCE, fakeModel(FILE_URI_STRING, 'body'))

    await vi.waitFor(() => expect(documents.$acceptDocumentOpen).toHaveBeenCalledTimes(2))
    expect(order).toEqual([
      `open:${UNTITLED_URI_STRING}`,
      `close:${UNTITLED_URI_STRING}`,
      `open:${FILE_URI_STRING}`,
    ])
  })
})
