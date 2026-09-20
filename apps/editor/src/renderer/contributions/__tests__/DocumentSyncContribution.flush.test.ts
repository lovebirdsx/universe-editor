/**
 * `PendingDocumentSync.flush(uri)` 是每个要读文档的 provider 调用（补全、保存参与者、did-save）
 * 的依据：宿主镜像至少要持有调用那一刻渲染侧的文本。
 *
 * 这是**版本**保证而不是定时器保证。这里钉住去抖表达不出的三种形状：批已在线上且后面没有排队、
 * 文档的 open 还没落地、以及调用之后到达的输入不属于这次等待。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { URI } from '@universe-editor/platform'
import { PendingDocumentSync } from '../../services/extensions/PendingDocumentSync.js'
import { DocumentSyncStats } from '../../services/extensions/documentSyncStats.js'
import { SaveParticipant } from '../../services/extensions/SaveParticipant.js'
import { WillSaveParticipantContribution } from '../WillSaveParticipantContribution.js'
import {
  deferred,
  fakeDocuments,
  fakeModel,
  setupDocumentSync,
  settle,
} from './documentSyncHarness.js'

const URI_STRING = 'file:///ws/flush.md'
const RESOURCE = URI.parse(URI_STRING)
const KEY = URI_STRING
const DEBOUNCE_MS = 200

describe('DocumentSyncContribution flush contract', () => {
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

  it('waits for the batch already on the wire, even with nothing queued behind it', async () => {
    const h = setupDocumentSync()
    const model = fakeModel(URI_STRING, 'seed')
    await open(h, model)

    const gate = deferred()
    h.documents.$acceptDocumentChange.mockImplementation(() => gate.promise)
    model.edit(0, 0, 'typed')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(1)

    // No debounce is pending — the old flush returned here, while the host had
    // not yet applied the keystroke.
    let flushed = false
    const flushing = PendingDocumentSync.flush(KEY).then(() => {
      flushed = true
    })
    await settle()
    expect(flushed).toBe(false)

    gate.resolve()
    await settle()
    await flushing
    expect(flushed).toBe(true)
  })

  it('pushes a debounced change now and resolves on the version the caller saw', async () => {
    const h = setupDocumentSync()
    const model = fakeModel(URI_STRING, 'seed')
    await open(h, model)

    model.edit(0, 0, 'typed')
    const versionAtCall = model.version()
    const gate = deferred()
    h.documents.$acceptDocumentChange.mockImplementation(() => gate.promise)

    let flushed = false
    const flushing = PendingDocumentSync.flush(KEY).then(() => {
      flushed = true
    })
    await settle()
    // The 200ms debounce is what a completion cannot afford to wait for.
    expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(1)
    expect(h.documents.$acceptDocumentChange.mock.calls[0]![1]).toBe(versionAtCall)
    expect(flushed).toBe(false)

    gate.resolve()
    await settle()
    await flushing
    expect(flushed).toBe(true)
  })

  it('does not chase input that arrives after the call', async () => {
    const h = setupDocumentSync()
    const model = fakeModel(URI_STRING, 'seed')
    await open(h, model)

    model.edit(0, 0, 'one')
    const gate = deferred()
    h.documents.$acceptDocumentChange.mockImplementation(() => gate.promise)

    let flushed = false
    const flushing = PendingDocumentSync.flush(KEY).then(() => {
      flushed = true
    })
    await settle()
    expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(1)

    // The user keeps typing while the host sits on the first batch.
    model.edit(0, 0, 'two')
    gate.resolve()
    await settle()
    await flushing
    expect(flushed).toBe(true)

    // The later edit is still owed — it is just not what this caller waited for.
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(2)
  })

  it('anchors the wait to the version at the call, not to edits made while it opens', async () => {
    const h = setupDocumentSync()
    const openGate = deferred()
    h.documents.$acceptDocumentOpen.mockImplementation(() => openGate.promise)
    const model = fakeModel(URI_STRING, 'seed')
    h.contribution.trackModel(RESOURCE, model.model)
    await settle()

    // The caller reads a document whose open has not landed yet: the version it will
    // see is the one the model has now.
    let flushed = false
    const flushing = PendingDocumentSync.flush(KEY).then(() => {
      flushed = true
    })
    await settle()
    expect(flushed).toBe(false)

    model.edit(0, 0, 'typed')
    const changeGate = deferred()
    h.documents.$acceptDocumentChange.mockImplementation(() => changeGate.promise)

    openGate.resolve()
    await settle()
    // The open acked the version the caller saw; the keystroke typed after the call
    // rides behind it and is not what this flush waits for.
    expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(1)
    await flushing
    expect(flushed).toBe(true)
  })

  it('waits for the open when the document has not been mirrored yet', async () => {
    const h = setupDocumentSync()
    const openGate = deferred()
    h.documents.$acceptDocumentOpen.mockImplementation(() => openGate.promise)
    const model = fakeModel(URI_STRING, 'seed')

    h.contribution.trackModel(RESOURCE, model.model)
    await settle()
    expect(h.documents.$acceptDocumentOpen).toHaveBeenCalledTimes(1)

    let flushed = false
    const flushing = PendingDocumentSync.flush(KEY).then(() => {
      flushed = true
    })
    await settle()
    expect(flushed).toBe(false)

    openGate.resolve()
    await settle()
    await flushing
    expect(flushed).toBe(true)
  })

  it('rebuilds the mirror a relaunch took away before answering', async () => {
    const h = setupDocumentSync()
    const model = fakeModel(URI_STRING, 'seed')
    await open(h, model)

    model.edit(0, 0, 'typed')
    const relaunched = fakeDocuments()
    h.setDocuments(relaunched)

    let flushed = false
    const flushing = PendingDocumentSync.flush(KEY).then(() => {
      flushed = true
    })
    await settle()
    expect(relaunched.$acceptDocumentOpen).toHaveBeenCalledTimes(1)
    expect(relaunched.$acceptDocumentOpen.mock.calls[0]![3]).toBe(model.text())
    expect(relaunched.$acceptDocumentChange).not.toHaveBeenCalled()
    await flushing
    expect(flushed).toBe(true)
  })

  it('resolves instead of hanging when the open never lands', async () => {
    const h = setupDocumentSync()
    h.documents.$acceptDocumentOpen.mockRejectedValue(new Error('channel closing'))
    const model = fakeModel(URI_STRING, 'seed')

    h.contribution.trackModel(RESOURCE, model.model)
    await settle()
    await expect(PendingDocumentSync.flush(KEY)).resolves.toBeUndefined()
  })

  it.each([false, true])(
    'rejects a stalled change without releasing its flight (already sent: %s)',
    async (alreadySent) => {
      const h = setupDocumentSync()
      const model = fakeModel(URI_STRING, 'seed')
      await open(h, model)
      const gate = deferred()
      h.documents.$acceptDocumentChange.mockImplementation(() => gate.promise)
      model.edit(0, 0, 'typed')
      if (alreadySent) await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

      let failure: unknown
      const flushing = PendingDocumentSync.flush(KEY).catch((error: unknown) => {
        failure = error
      })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(failure).toBeInstanceOf(Error)
      await flushing
      expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('flush timed out'))
      expect(DocumentSyncStats.read().inflightChars).toBe(5)

      model.edit(0, 0, 'later')
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(1)
      gate.resolve()
      await settle()
      await PendingDocumentSync.flush(KEY)
      expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(2)
      expect(DocumentSyncStats.read().inflightChars).toBe(0)
      h.contribution.dispose()
    },
  )

  it('lets save skip the extension participant when document sync times out', async () => {
    const h = setupDocumentSync()
    const model = fakeModel(URI_STRING, 'seed')
    await open(h, model)
    const gate = deferred()
    h.documents.$acceptDocumentChange.mockImplementation(() => gate.promise)
    const provideEdits = vi.fn(async () => [])
    const documents = { ...h.documents, $provideWillSaveEdits: provideEdits }
    const participant = new WillSaveParticipantContribution({
      getDocuments: () => documents,
    } as unknown as ConstructorParameters<typeof WillSaveParticipantContribution>[0])
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      model.edit(0, 0, 'typed')
      let finished = false
      const saving = SaveParticipant.participate(model.model, 1).then(() => {
        finished = true
      })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(finished).toBe(true)
      await saving
      expect(provideEdits).not.toHaveBeenCalled()
      expect(errors).toHaveBeenCalled()
    } finally {
      participant.dispose()
      gate.resolve()
      await settle()
      h.contribution.dispose()
      errors.mockRestore()
    }
  })

  it('shares one deadline between waiting for open and change', async () => {
    const h = setupDocumentSync()
    const openGate = deferred()
    const changeGate = deferred()
    h.documents.$acceptDocumentOpen.mockImplementation(() => openGate.promise)
    h.documents.$acceptDocumentChange.mockImplementation(() => changeGate.promise)
    const model = fakeModel(URI_STRING, 'seed')
    h.contribution.trackModel(RESOURCE, model.model)
    await settle()
    model.edit(0, 0, 'typed')

    let failure: unknown
    const flushing = PendingDocumentSync.flush(KEY).catch((error: unknown) => {
      failure = error
    })
    await vi.advanceTimersByTimeAsync(4_000)
    openGate.resolve()
    await settle()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(failure).toBeInstanceOf(Error)
    await flushing
    changeGate.resolve()
    await settle()
    h.contribution.dispose()
  })

  it('rejects when open does not acknowledge before the deadline', async () => {
    const h = setupDocumentSync()
    const gate = deferred()
    h.documents.$acceptDocumentOpen.mockImplementation(() => gate.promise)
    const model = fakeModel(URI_STRING, 'seed')
    h.contribution.trackModel(RESOURCE, model.model)
    await settle()
    let failure: unknown
    const flushing = PendingDocumentSync.flush(KEY).catch((error: unknown) => {
      failure = error
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(failure).toBeInstanceOf(Error)
    await flushing
    gate.resolve()
    await settle()
    h.contribution.dispose()
  })

  it('recovers with full text when the flushed batch fails', async () => {
    const h = setupDocumentSync()
    const model = fakeModel(URI_STRING, 'seed')
    await open(h, model)

    h.documents.$acceptDocumentChange.mockRejectedValueOnce(new Error('channel closing'))
    model.edit(0, 0, 'typed')
    await PendingDocumentSync.flush(KEY)
    await settle()
    expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(1)

    model.edit(0, 0, 'again')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(h.documents.$acceptDocumentChange).toHaveBeenCalledTimes(2)
    const [, , changes] = h.documents.$acceptDocumentChange.mock.calls[1]!
    expect(changes[0].range).toBeUndefined()
    expect(changes[0].text).toBe(model.text())
  })
})
