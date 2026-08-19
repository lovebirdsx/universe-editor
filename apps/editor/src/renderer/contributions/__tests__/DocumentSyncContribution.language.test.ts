/**
 * A model language switch (setTextDocumentLanguage / user "Change Language Mode")
 * re-mirrors the document as close(old) + open(new): the host sees
 * $acceptDocumentClose then a fresh $acceptDocumentOpen carrying the new
 * languageId, and the new language's activation event fires first.
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

type FakeModel = monaco.editor.ITextModel & { setLanguage(next: string): void }

function fakeModel(uriString: string, text: string, initialLanguageId = 'plaintext'): FakeModel {
  const willDispose = new Emitter<void>()
  const didChange = new Emitter<{ changes: readonly unknown[]; isFlush?: boolean }>()
  const didChangeLanguage = new Emitter<{ oldLanguage: string; newLanguage: string }>()
  let disposed = false
  let value = text
  let languageId = initialLanguageId
  return {
    uri: URI.parse(uriString),
    getValue: () => value,
    getVersionId: () => 1,
    getLanguageId: () => languageId,
    isDisposed: () => disposed,
    onDidChangeContent: didChange.event,
    onDidChangeLanguage: didChangeLanguage.event,
    onWillDispose: willDispose.event,
    setLanguage: (next: string) => {
      const old = languageId
      languageId = next
      didChangeLanguage.fire({ oldLanguage: old, newLanguage: next })
    },
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
      didChangeLanguage.dispose()
    },
  } as unknown as FakeModel
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

describe('DocumentSyncContribution language switch', () => {
  let contribution: DocumentSyncContribution | undefined

  afterEach(() => {
    contribution?.dispose()
    contribution = undefined
  })

  function setup() {
    const documents = {
      $acceptDocumentOpen: vi.fn().mockResolvedValue(undefined),
      $acceptDocumentChange: vi.fn().mockResolvedValue(undefined),
      $acceptDocumentClose: vi.fn().mockResolvedValue(undefined),
    }
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
    return { documents, client }
  }

  it('re-mirrors a language switch as close(old) + open(new) with activation', async () => {
    const { documents, client } = setup()
    const model = fakeModel(MODEL_URI_STRING, 'hello', 'plaintext')
    contribution!.trackModel(RESOURCE, model)
    await vi.waitFor(() => expect(documents.$acceptDocumentOpen).toHaveBeenCalledTimes(1))
    expect(documents.$acceptDocumentOpen.mock.calls[0]![1]).toBe('plaintext')

    model.setLanguage('javascript')

    await vi.waitFor(() => expect(documents.$acceptDocumentOpen).toHaveBeenCalledTimes(2))
    expect(documents.$acceptDocumentClose).toHaveBeenCalledTimes(1)
    expect(documents.$acceptDocumentOpen.mock.calls[1]![1]).toBe('javascript')
    expect(documents.$acceptDocumentOpen.mock.calls[1]![0].toString()).toBe(MODEL_URI_STRING)
    expect(client.activateByEvent).toHaveBeenCalledWith('onLanguage:javascript')
  })

  it('ignores a language event that reports the already-mirrored language', async () => {
    const { documents } = setup()
    const model = fakeModel(MODEL_URI_STRING, 'hello', 'plaintext')
    contribution!.trackModel(RESOURCE, model)
    await vi.waitFor(() => expect(documents.$acceptDocumentOpen).toHaveBeenCalledTimes(1))

    // A spurious event with no actual language change must not close+reopen.
    model.setLanguage('plaintext')
    await new Promise((r) => setTimeout(r, 10))

    expect(documents.$acceptDocumentOpen).toHaveBeenCalledTimes(1)
    expect(documents.$acceptDocumentClose).not.toHaveBeenCalled()
  })

  it('keeps content changes flowing to the host after the re-attach', async () => {
    const { documents } = setup()
    const model = fakeModel(MODEL_URI_STRING, 'hello', 'plaintext')
    contribution!.trackModel(RESOURCE, model)
    await vi.waitFor(() => expect(documents.$acceptDocumentOpen).toHaveBeenCalledTimes(1))

    model.setLanguage('javascript')
    await vi.waitFor(() => expect(documents.$acceptDocumentOpen).toHaveBeenCalledTimes(2))

    model.setValue('hello world')
    await vi.waitFor(() => expect(documents.$acceptDocumentChange).toHaveBeenCalled())
    const [uri, , changes] = documents.$acceptDocumentChange.mock.calls[0]!
    expect(uri.toString()).toBe(MODEL_URI_STRING)
    expect(changes[0]?.text).toBe('hello world')
  })
})
