/**
 * The contribution bridges DidSaveNotification to the host's $acceptDocumentSave.
 * Ordering contract: the save push must not overtake the document mirror's open
 * push (an untitled buffer's Save-As fires both in the same tick), because the
 * host drops saves for URIs it has never seen open.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { URI, type ILoggerService } from '@universe-editor/platform'
import { DidSaveNotificationContribution } from '../DidSaveNotificationContribution.js'
import { DidSaveNotification } from '../../services/extensions/DidSaveNotification.js'
import {
  DocumentMirrorTracking,
  type IDocumentMirrorTracker,
} from '../../services/extensions/DocumentMirrorTracking.js'
import type { IExtensionHostClientService } from '../../services/extensions/ExtensionHostClientService.js'

const URI_SAVED = URI.file('/ws/draft.txt')

function fakeTracker(whenOpened: IDocumentMirrorTracker['whenOpened']): IDocumentMirrorTracker {
  return { trackModel: () => true, isTracked: () => false, whenOpened }
}

function fakeLogger(warn: (msg: string) => void) {
  return { createLogger: () => ({ info: vi.fn(), warn }) } as unknown as ILoggerService
}

function fakeClient(documents: unknown) {
  return { getDocuments: () => documents } as unknown as IExtensionHostClientService
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('DidSaveNotificationContribution', () => {
  let contribution: DidSaveNotificationContribution | undefined
  let tracker: IDocumentMirrorTracker | undefined

  afterEach(() => {
    contribution?.dispose()
    contribution = undefined
    if (tracker) {
      DocumentMirrorTracking.unregister(tracker)
      tracker = undefined
    }
  })

  function setup(
    documents: unknown,
    whenOpened: IDocumentMirrorTracker['whenOpened'],
    warn = vi.fn(),
  ) {
    tracker = fakeTracker(whenOpened)
    DocumentMirrorTracking.register(tracker)
    contribution = new DidSaveNotificationContribution(fakeClient(documents), fakeLogger(warn))
    return { warn }
  }

  it('pushes did-save only after the mirror reports the document open', async () => {
    const saved: unknown[] = []
    const documents = {
      $acceptDocumentSave: vi.fn(async (u: unknown) => {
        saved.push(u)
      }),
    }
    let release!: (opened: boolean) => void
    setup(documents, () => new Promise<boolean>((r) => (release = r)))

    DidSaveNotification.notify(URI_SAVED)
    await flushMicrotasks()
    expect(documents.$acceptDocumentSave).not.toHaveBeenCalled()

    release(true)
    await vi.waitFor(() => expect(documents.$acceptDocumentSave).toHaveBeenCalledTimes(1))
    expect(saved[0]).toMatchObject({ scheme: 'file', path: '/ws/draft.txt' })
  })

  it('pushes immediately when the document is already mirrored', async () => {
    const documents = { $acceptDocumentSave: vi.fn().mockResolvedValue(undefined) }
    setup(documents, () => Promise.resolve(true))

    DidSaveNotification.notify(URI_SAVED)
    await vi.waitFor(() => expect(documents.$acceptDocumentSave).toHaveBeenCalledTimes(1))
  })

  it('still pushes (with a warning) when the mirror never opens the document', async () => {
    const documents = { $acceptDocumentSave: vi.fn().mockResolvedValue(undefined) }
    const { warn } = setup(documents, () => Promise.resolve(false))

    DidSaveNotification.notify(URI_SAVED)
    await vi.waitFor(() => expect(documents.$acceptDocumentSave).toHaveBeenCalledTimes(1))
    expect(warn).toHaveBeenCalled()
  })

  it('does nothing when the host has no documents channel', async () => {
    const whenOpened = vi.fn().mockResolvedValue(true)
    setup(undefined, whenOpened)

    DidSaveNotification.notify(URI_SAVED)
    await flushMicrotasks()
    expect(whenOpened).not.toHaveBeenCalled()
  })
})
