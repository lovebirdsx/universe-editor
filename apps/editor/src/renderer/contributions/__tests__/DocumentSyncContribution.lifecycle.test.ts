/**
 * 一个文档的镜像只有一条生命周期，但有多条离开它的路：摘除（模型 dispose / 关标签页）、语言切换
 * （close 旧 + open 新）、工作区切换（全部重推）、宿主重启（镜像随进程消失）。每一条都可能发生在
 * open 或批还在线上时，而「已经不存在的那一代」落地时不得认领当前这一代的状态。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { URI } from '@universe-editor/platform'
import { PendingDocumentSync } from '../../services/extensions/PendingDocumentSync.js'
import { DocumentSyncStats } from '../../services/extensions/documentSyncStats.js'
import {
  deferred,
  fakeDocuments,
  fakeModel,
  setupDocumentSync,
  settle,
} from './documentSyncHarness.js'

const URI_STRING = 'file:///ws/life.md'
const RESOURCE = URI.parse(URI_STRING)
const KEY = URI_STRING
const DEBOUNCE_MS = 200

describe('DocumentSyncContribution lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    DocumentSyncStats.clearAll()
  })

  async function open(
    h: ReturnType<typeof setupDocumentSync>,
    model: ReturnType<typeof fakeModel>,
  ) {
    h.contribution.trackModel(RESOURCE, model.model)
    await settle()
    expect(h.documents.$acceptDocumentOpen).toHaveBeenCalledTimes(1)
  }

  it('never sends the open of a document that detached while it was activating', async () => {
    const h = setupDocumentSync()
    const activation = deferred()
    h.client.activateByEvent.mockImplementation(() => activation.promise)
    const model = fakeModel(URI_STRING, 'seed')

    h.contribution.trackModel(RESOURCE, model.model)
    await settle()
    expect(h.documents.$acceptDocumentOpen).not.toHaveBeenCalled()

    model.dispose()
    await settle()
    expect(h.documents.$acceptDocumentClose).toHaveBeenCalledTimes(1)

    activation.resolve()
    await settle()
    // A mirror opened after its document went away would have nobody to close it.
    expect(h.documents.$acceptDocumentOpen).not.toHaveBeenCalled()
  })

  it('drops a batch that lands after the document was detached', async () => {
    const h = setupDocumentSync()
    const model = fakeModel(URI_STRING, 'seed')
    await open(h, model)

    const gate = deferred()
    h.documents.$acceptDocumentChange.mockImplementation(() => gate.promise)
    model.edit(0, 0, 'typed')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(1)

    model.dispose()
    await settle()
    expect(h.documents.$acceptDocumentClose).toHaveBeenCalledTimes(1)

    gate.resolve()
    await settle()
    expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(1)
    expect(DocumentSyncStats.read().openDocs).toBe(0)
    expect(DocumentSyncStats.read().pendingChars).toBe(0)

    // The flusher went with the entry: nothing flushes for a closed document.
    await expect(PendingDocumentSync.flush(KEY)).resolves.toBeUndefined()
    expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(1)
  })

  it('re-mirrors on a language switch and keeps syncing the new mirror', async () => {
    const h = setupDocumentSync()
    const model = fakeModel(URI_STRING, 'seed')
    await open(h, model)
    const order: string[] = []
    h.documents.$acceptDocumentClose.mockImplementation(async () => {
      order.push('close')
    })
    h.documents.$acceptDocumentOpen.mockImplementation(async (uri: URI, languageId: string) => {
      order.push(`open:${languageId}`)
    })

    const gate = deferred()
    h.documents.$acceptDocumentChange.mockImplementation(() => gate.promise)
    model.edit(0, 0, 'typed')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(1)

    model.setLanguage('markdown')
    await settle()
    expect(order).toEqual(['close', 'open:markdown'])
    const [, languageId, , text] = h.documents.$acceptDocumentOpen.mock.calls[1]!
    expect(languageId).toBe('markdown')
    expect(text).toBe(model.text())

    // The old entry's batch acks after the switch: it must push nothing more.
    gate.resolve()
    await settle()
    expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(1)

    model.edit(0, 0, 'after')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(2)
    const [, , changes] = h.documents.$acceptDocumentChange.mock.calls[1]!
    expect(changes[0].range).toBeDefined()
    expect(changes[0].text).toBe('after')
    expect(DocumentSyncStats.read().openDocs).toBe(1)
  })

  it('re-pushes every mirror on a workspace change, serialized behind the batch in the air', async () => {
    const h = setupDocumentSync()
    const model = fakeModel(URI_STRING, 'seed')
    await open(h, model)

    const gate = deferred()
    h.documents.$acceptDocumentChange.mockImplementation(() => gate.promise)
    model.edit(0, 0, 'typed')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(1)

    h.fireWorkspaceChange()
    await settle()
    // The batch is still in the air: the replacing open must not overtake it, or the
    // batch's late ack lands on a mirror it never modified.
    expect(h.documents.$acceptDocumentOpen).toHaveBeenCalledTimes(1)

    gate.resolve()
    await settle()
    expect(h.documents.$acceptDocumentOpen).toHaveBeenCalledTimes(2)
    expect(h.documents.$acceptDocumentOpen.mock.calls[1]![3]).toBe(model.text())
    expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(1)

    model.edit(0, 0, 'after')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(2)
    const [, , changes] = h.documents.$acceptDocumentChange.mock.calls[1]!
    expect(changes[0].range).toBeDefined()
  })

  it('re-opens instead of pushing deltas into a host generation that never saw the open', async () => {
    const h = setupDocumentSync()
    const model = fakeModel(URI_STRING, 'seed')
    await open(h, model)

    model.edit(0, 0, 'before')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(1)

    // The host crashed and was restarted: a fresh proxy with an empty mirror.
    const relaunched = fakeDocuments()
    h.setDocuments(relaunched)

    model.edit(0, 0, 'after')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    await settle()
    // Deltas would be dropped host-side (no prior open), so the mirror is rebuilt.
    expect(relaunched.$acceptDocumentChange).not.toHaveBeenCalled()
    expect(relaunched.$acceptDocumentOpen).toHaveBeenCalledTimes(1)
    expect(relaunched.$acceptDocumentOpen.mock.calls[0]![3]).toBe(model.text())

    model.edit(0, 0, 'more')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(relaunched.$acceptDocumentChange).toHaveBeenCalledTimes(1)
    const [, , changes] = relaunched.$acceptDocumentChange.mock.calls[0]!
    expect(changes[0].range).toBeDefined()
    expect(changes[0].text).toBe('more')
  })

  it('owes a full push when the host goes away under a live mirror', async () => {
    const h = setupDocumentSync()
    const model = fakeModel(URI_STRING, 'seed')
    await open(h, model)

    // The host died: the queued deltas have no base to apply to anywhere.
    h.dropHost()
    model.edit(0, 0, 'while away')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(DocumentSyncStats.read().fullDocs).toBe(1)
    expect(DocumentSyncStats.read().pendingChars).toBe(0)

    const back = fakeDocuments()
    h.setDocuments(back)
    await PendingDocumentSync.flush(KEY)
    expect(back.$acceptDocumentOpen).toHaveBeenCalledTimes(1)
    expect(back.$acceptDocumentOpen.mock.calls[0]![3]).toBe(model.text())
    expect(DocumentSyncStats.read().fullDocs).toBe(0)
  })

  it('merges a resync that arrives while an open is in the air into a follow-up open', async () => {
    const h = setupDocumentSync()
    const gate = deferred()
    h.documents.$acceptDocumentOpen.mockImplementation(() => gate.promise)
    const model = fakeModel(URI_STRING, 'seed')
    h.contribution.trackModel(RESOURCE, model.model)
    await settle()
    expect(h.documents.$acceptDocumentOpen).toHaveBeenCalledTimes(1)

    model.edit(0, 0, 'typed')
    h.fireWorkspaceChange()
    await settle()
    // One open per document at a time, and the resync must not be swallowed by it.
    expect(h.documents.$acceptDocumentOpen).toHaveBeenCalledTimes(1)

    gate.resolve()
    await settle()
    expect(h.documents.$acceptDocumentOpen).toHaveBeenCalledTimes(2)
    expect(h.documents.$acceptDocumentOpen.mock.calls[1]![3]).toBe(model.text())
  })

  it('holds the deltas while a resync open waits on activation', async () => {
    const h = setupDocumentSync()
    const model = fakeModel(URI_STRING, 'seed')
    await open(h, model)

    // A workspace change re-arms activation: the replacing open now waits on it (the
    // host may be booting), which is the widest window the pipeline has.
    const activation = deferred()
    h.client.activateByEvent.mockImplementation(() => activation.promise)
    const openGate = deferred()
    h.documents.$acceptDocumentOpen.mockImplementation(() => openGate.promise)
    h.fireWorkspaceChange()
    await settle()

    model.edit(0, 0, 'typed')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    // The open has not been sent yet. A batch here would put the document's full text and
    // its delta on the wire at the same time, and the batch's ack would clear the reading
    // of the text the open is holding.
    expect(h.documents.$acceptDocumentChange).not.toHaveBeenCalled()
    expect(h.documents.$acceptDocumentOpen).toHaveBeenCalledTimes(1)
    expect(DocumentSyncStats.read().pendingChars).toBe('typed'.length)

    activation.resolve()
    await settle()
    // The open is on the wire now: the whole text is what the pipeline holds, and the
    // edit rides it rather than being sent as its own batch.
    expect(h.documents.$acceptDocumentOpen).toHaveBeenCalledTimes(2)
    expect(h.documents.$acceptDocumentOpen.mock.calls[1]![3]).toBe(model.text())
    expect(DocumentSyncStats.read().inflightChars).toBe(model.text().length)

    openGate.resolve()
    await settle()
    expect(h.documents.$acceptDocumentChange).not.toHaveBeenCalled()
    const stats = DocumentSyncStats.read()
    expect(stats.openChars).toBe(model.text().length)
    expect(stats.pendingChars + stats.inflightChars).toBe(0)

    model.edit(0, 0, ' after')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(1)
    const [, , changes] = h.documents.$acceptDocumentChange.mock.calls[0]!
    expect(changes[0].range).toBeDefined()
    expect(changes[0].text).toBe(' after')
  })

  it('does not owe a full push after a resync rebuilt the mirror', async () => {
    const h = setupDocumentSync()
    const model = fakeModel(URI_STRING, 'seed')
    await open(h, model)

    const activation = deferred()
    h.client.activateByEvent.mockImplementation(() => activation.promise)
    // Gate whatever the pipeline puts on the wire before the replacement open is sent —
    // the batch the pre-fix code sent in that window — and behave normally after it.
    const batchGate = deferred()
    void batchGate.promise.catch(() => undefined)
    let beforeReplacementOpen = true
    h.documents.$acceptDocumentChange.mockImplementation(() =>
      beforeReplacementOpen ? batchGate.promise : Promise.resolve(),
    )
    h.documents.$acceptDocumentOpen.mockImplementation(async () => {
      beforeReplacementOpen = false
    })
    h.fireWorkspaceChange()
    await settle()
    model.edit(0, 0, 'typed')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    activation.resolve()
    await settle()
    expect(h.documents.$acceptDocumentOpen).toHaveBeenCalledTimes(2)
    // A batch from that window failing after the replacement open landed must not leave a
    // whole-document debt behind: the mirror is current (the open carried this text), so
    // the next edit is a delta, not a full push.
    batchGate.reject(new Error('channel closing'))
    await settle()

    model.edit(0, 0, ' after')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    const calls = h.documents.$acceptDocumentChange.mock.calls
    const [, , changes] = calls[calls.length - 1]!
    expect(changes).toHaveLength(1)
    expect(changes[0].range).toBeDefined()
    expect(changes[0].text).toBe(' after')
    expect(DocumentSyncStats.read().fullDocs).toBe(0)
  })

  it('keeps the re-opened mirror reading when a superseded batch lands late', async () => {
    const h = setupDocumentSync()
    const model = fakeModel(URI_STRING, 'seed')
    await open(h, model)

    const gate = deferred()
    h.documents.$acceptDocumentChange.mockImplementation(() => gate.promise)
    model.edit(0, 0, 'typed')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(1)

    const openGate = deferred()
    h.documents.$acceptDocumentOpen.mockImplementation(() => openGate.promise)
    model.setLanguage('markdown')
    await settle()
    // The replacement mirror holds its whole text on the wire; the dead batch's late
    // completion belongs to an entry that is gone and may not clear this one.
    expect(DocumentSyncStats.read().inflightChars).toBe(model.text().length)

    gate.resolve()
    await settle()
    expect(DocumentSyncStats.read().inflightChars).toBe(model.text().length)

    openGate.resolve()
    await settle()
    expect(DocumentSyncStats.read().inflightChars).toBe(0)
  })

  it('opens a document when the host comes up during its activation', async () => {
    const h = setupDocumentSync()
    h.dropHost()
    const up = fakeDocuments()
    const gate = deferred()
    h.client.activateByEvent.mockImplementation(() => gate.promise)
    const model = fakeModel(URI_STRING, 'seed')

    h.contribution.trackModel(RESOURCE, model.model)
    await settle()
    // Activation is what starts the host: it cannot be skipped just because the
    // documents proxy does not exist yet.
    expect(h.client.activateByEvent).toHaveBeenCalledTimes(1)
    expect(up.$acceptDocumentOpen).not.toHaveBeenCalled()

    h.setDocuments(up)
    gate.resolve()
    await settle()
    expect(up.$acceptDocumentOpen).toHaveBeenCalledTimes(1)
    expect(up.$acceptDocumentOpen.mock.calls[0]![3]).toBe(model.text())
  })

  it('tracks each re-opened mirror under the same document, once', async () => {
    const h = setupDocumentSync()
    const model = fakeModel(URI_STRING, 'seed')
    await open(h, model)
    expect(DocumentSyncStats.read().openDocs).toBe(1)

    h.fireWorkspaceChange()
    await settle()
    expect(DocumentSyncStats.read().openDocs).toBe(1)
    expect(DocumentSyncStats.read().openChars).toBe(model.text().length)
  })
})
