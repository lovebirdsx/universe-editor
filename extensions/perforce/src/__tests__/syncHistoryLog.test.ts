import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { mkTempDir } from '@universe-editor/temp-root'
import {
  buildSyncHistoryEntry,
  SyncHistoryLog,
  type BuildSyncHistoryInput,
} from '../syncHistory.js'

const ROOT = 'X:/p4ws/main'
const OTHER_ROOT = 'X:/p4ws/other'

let dir: string
let log: ((msg: string) => void) | undefined
const logged: string[] = []

function makeEntry(at: number, extra: Partial<BuildSyncHistoryInput> = {}) {
  return buildSyncHistoryEntry({
    id: `${at}-1`,
    at,
    clientRoot: ROOT,
    spec: '#head',
    force: false,
    trigger: 'explorer',
    scope: [{ path: `${ROOT}/src`, isDirectory: true }],
    scopeNarrowed: false,
    outcome: 'applied',
    run: { ok: true, cancelled: false, summary: undefined, error: undefined },
    ...extra,
  })
}

function open(): SyncHistoryLog {
  const instance = SyncHistoryLog.open(dir, log)
  expect(instance).toBeDefined()
  return instance!
}

beforeEach(() => {
  dir = mkTempDir('p4-sync-history-')
  logged.length = 0
  log = (msg: string) => logged.push(msg)
})

describe('SyncHistoryLog', () => {
  it('returns undefined when there is no storage root', () => {
    expect(SyncHistoryLog.open('')).toBeUndefined()
  })

  it('lists newest first with total and hasMore', () => {
    const history = open()
    for (const at of [100, 200, 300, 400, 500]) history.record(makeEntry(at))
    const page = history.list({ max: 2 })
    expect(page.entries.map((e) => e.at)).toEqual([500, 400])
    expect(page.total).toBe(5)
    expect(page.hasMore).toBe(true)
    const rest = history.list({ max: 10 })
    expect(rest.entries).toHaveLength(5)
    expect(rest.hasMore).toBe(false)
  })

  it('filters by client root using path identity, not raw string equality', () => {
    const history = open()
    history.record(makeEntry(100))
    history.record(makeEntry(200, { clientRoot: OTHER_ROOT }))
    // Trailing slash + backslashes normalize to the same root.
    const page = history.list({ max: 10, root: 'X:\\p4ws\\main\\' })
    expect(page.entries.map((e) => e.at)).toEqual([100])
    expect(page.total).toBe(1)
  })

  it('keeps duplicate timestamps as separate entries', () => {
    const history = open()
    history.record(makeEntry(100, { id: 'a' }))
    history.record(makeEntry(100, { id: 'b' }))
    // Same-millisecond order is not a contract (a real run takes far longer);
    // both records surviving is.
    const ids = history.list({ max: 10 }).entries.map((e) => e.id)
    expect(new Set(ids)).toEqual(new Set(['a', 'b']))
  })

  it('replaces an entry recorded twice under the same id instead of duplicating it', () => {
    const history = open()
    history.record(makeEntry(100, { id: 'same' }))
    history.record(makeEntry(100, { id: 'same', outcome: 'failed' }))
    const page = history.list({ max: 10 })
    expect(page.entries).toHaveLength(1)
    expect(page.entries[0]?.outcome).toBe('failed')
  })

  it('drops the oldest entries by timestamp, not by arrival order', () => {
    const history = open()
    // A rewound clock: entry 250 arrives last but sits in the middle.
    history.record(makeEntry(100))
    history.record(makeEntry(300))
    for (let at = 301; at <= 498; at++) history.record(makeEntry(at))
    history.record(makeEntry(250))
    const page = history.list({ max: 1000 })
    // 201 recorded -> the single oldest (100) is evicted, 250 survives.
    expect(page.total).toBe(200)
    expect(page.entries.map((e) => e.at)).not.toContain(100)
    expect(page.entries.map((e) => e.at)).toContain(250)
  })

  it('starts empty on a corrupt file and rewrites it on the next record', () => {
    const history = open()
    history.record(makeEntry(100))
    writeFileSync(join(dir, 'syncHistory.json'), '{ not json')
    const reopened = open()
    expect(reopened.list({ max: 10 }).entries).toEqual([])
    reopened.record(makeEntry(200))
    expect(reopened.list({ max: 10 }).entries.map((e) => e.at)).toEqual([200])
  })

  it('drops fabricated entries a hand-edited file may carry', () => {
    const history = open()
    history.record(makeEntry(100))
    writeFileSync(
      join(dir, 'syncHistory.json'),
      JSON.stringify({
        version: 1,
        entries: [
          { id: 'fake', at: 200, clientRoot: ROOT, outcome: 'applied' },
          { ...makeEntry(100), id: 'ok' },
        ],
      }),
    )
    const page = open().list({ max: 10 })
    expect(page.entries.map((e) => e.id)).toEqual(['ok'])
  })

  it('sees another window writes without a restart', () => {
    const a = open()
    const b = open()
    a.record(makeEntry(100))
    expect(b.list({ max: 10 }).entries.map((e) => e.at)).toEqual([100])
    b.record(makeEntry(200))
    expect(a.list({ max: 10 }).entries.map((e) => e.at)).toEqual([200, 100])
  })

  it('finds an entry by id', () => {
    const history = open()
    history.record(makeEntry(100, { id: 'wanted' }))
    expect(history.get('wanted')?.at).toBe(100)
    expect(history.get('missing')).toBeUndefined()
  })

  it('never throws when the write fails, and says so in the log', () => {
    const history = open()
    // A directory squatting on the file path makes the final rename fail.
    mkdirSync(join(dir, 'syncHistory.json'))
    expect(() => history.record(makeEntry(100))).not.toThrow()
    expect(logged.some((m) => m.includes('sync history write failed'))).toBe(true)
  })

  it('clamps a silly page size instead of returning everything', () => {
    const history = open()
    history.record(makeEntry(100))
    expect(history.list({ max: 0 }).entries).toHaveLength(1)
    expect(() => history.list({ max: Number.NaN })).not.toThrow()
  })
})

describe('SyncHistoryLog.open', () => {
  it('creates the directory when it does not exist yet', () => {
    const nested = join(dir, 'deep', 'nested')
    const history = SyncHistoryLog.open(nested, log)
    expect(history).toBeDefined()
    history!.record(makeEntry(100))
    expect(history!.list({ max: 10 }).entries).toHaveLength(1)
  })

  it('reports the backing file', () => {
    const history = open()
    expect(history.file).toBe(join(dir, 'syncHistory.json'))
  })

  it('does not let a throwing log sink escape (red line 4)', () => {
    const history = SyncHistoryLog.open(dir, () => {
      throw new Error('log boom')
    })
    expect(history).toBeDefined()
    // The write fails (a directory squats the file path), so the sink IS called.
    mkdirSync(join(dir, 'syncHistory.json'))
    expect(() => history!.record(makeEntry(100))).not.toThrow()
  })
})
