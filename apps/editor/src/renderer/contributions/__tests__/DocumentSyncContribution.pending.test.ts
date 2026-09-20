/**
 * 出站积压的契约（2026-09-19 OOM 的「攒」那一半，见 `docs/development/memory-pressure.md`）：
 * 按字符数与条数封顶、判定时不读文档（快照只在推送时取）、每文档同时至多一个批在线、批失败
 * 后下一次整篇镜像而不是去打补丁。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { URI } from '@universe-editor/platform'
import { readHeapFlowTotals } from '../../services/memory/heapFlowCounters.js'
import { DocumentSyncStats } from '../../services/extensions/documentSyncStats.js'
import { deferred, fakeModel, setupDocumentSync, settle } from './documentSyncHarness.js'

const URI_STRING = 'file:///ws/big.log'
const RESOURCE = URI.parse(URI_STRING)
const MAX_PENDING_CHARS = 2 * 1024 * 1024
const MAX_PENDING_ENTRIES = 1000
const MEG = 1024 * 1024
const DEBOUNCE_MS = 200

function flowChars(name: 'docpush' | 'docdrop'): number {
  return readHeapFlowTotals().find((f) => f.name === name)?.chars ?? 0
}

/** The payload a change call carried, in code units. */
function payloadChars(call: unknown[]): number {
  const changes = call[2] as readonly { text: string }[]
  return changes.reduce((sum, c) => sum + c.text.length, 0)
}

describe('DocumentSyncContribution pending backlog', () => {
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

  it('collapses an unbounded near-full delta backlog into one full-text push', async () => {
    const h = setupDocumentSync()
    const model = fakeModel(URI_STRING, 'seed')
    await open(h, model)
    const dropBefore = flowChars('docdrop')

    // The incident shape: the debounce never runs (main thread stalled) while
    // near-full deltas keep arriving.
    const meg = 'b'.repeat(MEG)
    for (let i = 0; i < 6; i++) {
      model.edit(0, model.text().length, meg)
      const stats = DocumentSyncStats.read()
      expect(stats.pendingChars).toBeLessThanOrEqual(MAX_PENDING_CHARS)
      // The cap drops deltas; reading the text here would move the cost, not remove it.
      expect(model.fullReads()).toBe(1)
    }
    expect(DocumentSyncStats.read().fullDocs).toBe(1)

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(1)
    const [, , changes] = h.documents.$acceptDocumentChange.mock.calls[0]!
    expect(changes).toHaveLength(1)
    expect(changes[0].range).toBeUndefined()
    expect(changes[0].text).toBe(model.text())
    expect(flowChars('docdrop') - dropBefore).toBeGreaterThan(0)
  })

  it('caps the delta count as well, so a burst of tiny edits cannot accumulate', async () => {
    const h = setupDocumentSync()
    const model = fakeModel(URI_STRING, 'seed')
    await open(h, model)

    for (let i = 0; i < MAX_PENDING_ENTRIES; i++) model.edit(0, 0, 'x')
    expect(DocumentSyncStats.read().pendingDeltas).toBe(MAX_PENDING_ENTRIES)
    expect(DocumentSyncStats.read().fullDocs).toBe(0)

    model.edit(0, 0, 'x')
    expect(DocumentSyncStats.read().pendingDeltas).toBe(0)
    expect(DocumentSyncStats.read().fullDocs).toBe(1)

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(1)
    const [, , changes] = h.documents.$acceptDocumentChange.mock.calls[0]!
    expect(changes).toHaveLength(1)
    expect(changes[0].text).toBe(model.text())
  })

  it('holds a bounded backlog while the open is still on the wire', async () => {
    const h = setupDocumentSync()
    const openGate = deferred()
    h.documents.$acceptDocumentOpen.mockImplementation(() => openGate.promise)
    const model = fakeModel(URI_STRING, 'seed')
    h.contribution.trackModel(RESOURCE, model.model)
    await settle()
    expect(h.documents.$acceptDocumentOpen).toHaveBeenCalledTimes(1)

    const meg = 'c'.repeat(MEG)
    for (let i = 0; i < 5; i++) model.edit(0, model.text().length, meg)
    // Nothing can be pushed before the host has a base to apply it to.
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 5)
    expect(h.documents.$acceptDocumentChange).not.toHaveBeenCalled()
    expect(DocumentSyncStats.read().pendingChars).toBeLessThanOrEqual(MAX_PENDING_CHARS)

    openGate.resolve()
    await settle()
    expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(1)
    const [, , changes] = h.documents.$acceptDocumentChange.mock.calls[0]!
    expect(changes).toHaveLength(1)
    expect(changes[0].range).toBeUndefined()
    expect(changes[0].text).toBe(model.text())
    expect(payloadChars(h.documents.$acceptDocumentChange.mock.calls[0]!)).toBe(model.text().length)
  })

  it('keeps one batch in flight per document while the host is slow', async () => {
    const h = setupDocumentSync()
    const model = fakeModel(URI_STRING, 'seed')
    await open(h, model)
    const gate = deferred()
    h.documents.$acceptDocumentChange.mockImplementation(() => gate.promise)

    model.edit(0, 0, 'one')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(1)

    // Edits keep coming while the host sits on the first batch.
    for (let i = 0; i < 5; i++) {
      model.edit(0, 0, 'more')
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    }
    expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(1)
    const stats = DocumentSyncStats.read()
    expect(stats.inflightDocs).toBe(1)
    expect(stats.inflightChars).toBeGreaterThan(0)
    expect(stats.pendingChars).toBeLessThanOrEqual(MAX_PENDING_CHARS)

    gate.resolve()
    await settle()
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(2)
    const second = h.documents.$acceptDocumentChange.mock.calls[1]!
    expect(payloadChars(second)).toBe(4 * 5)
    expect((second[2] as readonly { range?: unknown }[])[0]?.range).toBeDefined()
    expect(DocumentSyncStats.read().inflightDocs).toBe(0)
  })

  it('mirrors the whole text after a failed batch instead of patching', async () => {
    const h = setupDocumentSync()
    const model = fakeModel(URI_STRING, 'seed')
    await open(h, model)

    const pushBefore = flowChars('docpush')
    h.documents.$acceptDocumentChange.mockRejectedValueOnce(new Error('channel closing'))
    model.edit(0, 0, 'typo')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    await settle()
    expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(1)

    model.edit(0, 0, 'typo2')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(2)
    const [, , changes] = h.documents.$acceptDocumentChange.mock.calls[1]!
    expect(changes).toHaveLength(1)
    expect(changes[0].range).toBeUndefined()
    expect(changes[0].text).toBe(model.text())
    expect(flowChars('docpush') - pushBefore).toBeGreaterThanOrEqual(model.text().length)
  })

  it('counts pushed payload on the docpush flow', async () => {
    const h = setupDocumentSync()
    const model = fakeModel(URI_STRING, 'seed')
    await open(h, model)

    const before = flowChars('docpush')
    model.edit(0, 0, 'abc')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(flowChars('docpush') - before).toBe(3)
  })

  it('keeps small edits incremental and debounced', async () => {
    const h = setupDocumentSync()
    const model = fakeModel(URI_STRING, 'seed')
    await open(h, model)

    model.edit(0, 0, 'a')
    model.edit(model.text().length, 0, 'b')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1)
    expect(h.documents.$acceptDocumentChange).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(1)
    const [, version, changes] = h.documents.$acceptDocumentChange.mock.calls[0]!
    expect(changes).toHaveLength(2)
    expect(changes.every((c: { range?: unknown }) => c.range !== undefined)).toBe(true)
    expect(version).toBe(model.version())
    expect(model.fullReads()).toBe(1)
  })

  it('counts the open snapshot as held text while it is on the wire', async () => {
    const h = setupDocumentSync()
    const openGate = deferred()
    h.documents.$acceptDocumentOpen.mockImplementation(() => openGate.promise)
    const model = fakeModel(URI_STRING, 'seed')
    h.contribution.trackModel(RESOURCE, model.model)
    await settle()

    // The full text really is held while the open is being sent — it is the payload
    // the reading exists to make visible — and it stops being held once it lands.
    expect(DocumentSyncStats.read().inflightDocs).toBe(1)
    expect(DocumentSyncStats.read().inflightChars).toBe(model.text().length)

    openGate.resolve()
    await settle()
    const stats = DocumentSyncStats.read()
    expect(stats.inflightChars).toBe(0)
    expect(stats.inflightDocs).toBe(0)
    expect(stats.openChars).toBe(model.text().length)
  })

  it('reports the mirror it is carrying, and nothing after teardown', async () => {
    const h = setupDocumentSync()
    const model = fakeModel(URI_STRING, 'seed')
    await open(h, model)

    const stats = DocumentSyncStats.read()
    expect(stats.openDocs).toBe(1)
    expect(stats.openChars).toBe(model.text().length)
    expect(stats.pendingChars).toBe(0)
    expect(stats.inflightChars).toBe(0)

    h.contribution.dispose()
    expect(DocumentSyncStats.read()).toEqual({
      openDocs: 0,
      openChars: 0,
      pendingDocs: 0,
      pendingDeltas: 0,
      pendingChars: 0,
      inflightDocs: 0,
      inflightChars: 0,
      fullDocs: 0,
    })
  })
})
