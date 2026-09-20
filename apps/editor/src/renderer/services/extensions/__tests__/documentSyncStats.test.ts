/**
 * 读数必须能从同步路径已知的东西上维护（一个长度、一个已累加的字符和）：持载荷的正是采样负担
 * 不起的管道（为要一个数去读 10MB 文档，正是这套读数要暴露的成本）。
 *
 * 每次写入都走它描述的那个镜像的句柄：被替换掉的文档（语言切换、重启）迟到落地时句柄已过期，
 * 不得改动同键下新镜像装进去的记录。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentSyncStats, measureDocumentSyncPayload } from '../documentSyncStats.js'

const KEY = 'file:///ws/a.log'
const OTHER = 'file:///ws/b.log'

describe('documentSyncStats', () => {
  beforeEach(() => {
    DocumentSyncStats.clearAll()
  })

  afterEach(() => {
    DocumentSyncStats.clearAll()
  })

  it('sums the payload across documents', () => {
    const a = DocumentSyncStats.track(KEY)
    const b = DocumentSyncStats.track(OTHER)
    a.setOpenChars(10_000)
    b.setOpenChars(20)
    a.setPending(3, 300, false)
    a.setInflight(5_000)
    b.setPending(0, 0, true)

    expect(DocumentSyncStats.read()).toEqual({
      openDocs: 2,
      openChars: 10_020,
      pendingDocs: 2,
      pendingDeltas: 3,
      pendingChars: 300,
      inflightDocs: 1,
      inflightChars: 5_000,
      fullDocs: 1,
    })
  })

  it('reads zero once a document is gone instead of freezing its last state', () => {
    const a = DocumentSyncStats.track(KEY)
    a.setPending(2, 200, false)
    a.setInflight(4_000)

    a.release()
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

  it('drops the writes of a mirror that was replaced under the same key', () => {
    const superseded = DocumentSyncStats.track(KEY)
    superseded.setInflight(6_000)
    // 语言切换：同一个 key 上换了新镜像，旧句柄代表的那份已经不在了
    const current = DocumentSyncStats.track(KEY)
    current.setInflight(400)

    superseded.setInflight(0)
    superseded.setPending(9, 900, true)
    superseded.setOpenChars(123)
    superseded.release()

    const stats = DocumentSyncStats.read()
    expect(stats.inflightChars).toBe(400)
    expect(stats.pendingDeltas).toBe(0)
    expect(stats.openChars).toBe(0)
    expect(stats.openDocs).toBe(1)
  })

  it('re-opening a document keeps a single record', () => {
    DocumentSyncStats.track(KEY)
    DocumentSyncStats.track(KEY)
    expect(DocumentSyncStats.read().openDocs).toBe(1)
  })

  it('rejects counts that are not a payload rather than clamping them', () => {
    const a = DocumentSyncStats.track(KEY)
    a.setPending(Number.NaN, -5, false)
    a.setInflight(Number.POSITIVE_INFINITY)
    expect(DocumentSyncStats.read().pendingChars).toBe(0)
    expect(DocumentSyncStats.read().inflightChars).toBe(0)
  })

  it('reports backlog bytes as a holder and stays silent with none', () => {
    const a = DocumentSyncStats.track(KEY)
    expect(measureDocumentSyncPayload()).toBeUndefined()

    a.setPending(1, 1_000, false)
    expect(measureDocumentSyncPayload()).toEqual({ bytes: 2_000, count: 1 })

    a.setInflight(500)
    expect(measureDocumentSyncPayload()).toEqual({ bytes: 3_000, count: 1 })

    // The mirrored text itself belongs to the Monaco holder — this one only
    // answers for what the sync path built on top of it.
    a.setPending(0, 0, false)
    a.setInflight(0)
    expect(measureDocumentSyncPayload()).toBeUndefined()

    a.setOpenChars(999_999)
    expect(measureDocumentSyncPayload()).toBeUndefined()
  })

  it('zeroes everything on teardown', () => {
    const a = DocumentSyncStats.track(KEY)
    a.setPending(1, 10, true)
    a.setInflight(10)

    DocumentSyncStats.clearAll()
    expect(DocumentSyncStats.read().openDocs).toBe(0)
    expect(DocumentSyncStats.read().pendingChars).toBe(0)
    expect(DocumentSyncStats.read().inflightChars).toBe(0)
  })
})
