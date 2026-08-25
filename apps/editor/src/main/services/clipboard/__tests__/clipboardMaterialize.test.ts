import { describe, expect, it } from 'vitest'
import {
  MATERIALIZE_STALE_MS,
  createSessionId,
  isStaleSession,
  selectSessionsToDelete,
  sessionSeq,
} from '../clipboardMaterialize.js'

describe('createSessionId', () => {
  it('is sequence-prefixed and stable per inputs', () => {
    const id = createSessionId(3, 'abcd1234')
    expect(id).toBe('s3-abcd1234')
    expect(id).toBe(createSessionId(3, 'abcd1234'))
  })

  it('is unique per sequence and random suffix (no timestamp source)', () => {
    const ids = new Set<string>()
    for (let seq = 1; seq <= 50; seq++) {
      ids.add(createSessionId(seq, Math.random().toString(16).slice(2)))
    }
    expect(ids.size).toBe(50)
    // Format: sequence + random hex suffix, never a date-ish pattern.
    for (const id of ids) expect(id).toMatch(/^s\d+-[0-9a-f]+$/)
  })
})

describe('selectSessionsToDelete', () => {
  it('keeps the two most recently modified sessions', () => {
    const sessions = [
      { name: 's1-old', mtimeMs: 100 },
      { name: 's3-newest', mtimeMs: 300 },
      { name: 's2-mid', mtimeMs: 200 },
    ]
    expect(selectSessionsToDelete(sessions).sort()).toEqual(['s1-old'])
  })

  it('deletes everything beyond the configured keep count', () => {
    const sessions = [
      { name: 'a', mtimeMs: 10 },
      { name: 'b', mtimeMs: 20 },
      { name: 'c', mtimeMs: 30 },
      { name: 'd', mtimeMs: 40 },
    ]
    expect(selectSessionsToDelete(sessions, 2).sort()).toEqual(['a', 'b'])
    expect(selectSessionsToDelete(sessions, 1).sort()).toEqual(['a', 'b', 'c'])
  })

  it('returns nothing when under the keep count', () => {
    expect(selectSessionsToDelete([{ name: 'a', mtimeMs: 1 }])).toEqual([])
    expect(selectSessionsToDelete([])).toEqual([])
    expect(selectSessionsToDelete([]).length).toBe(0)
  })

  it('breaks mtime ties by sequence so the newest session survives', () => {
    // Two writes inside the same filesystem timestamp tick: mtime alone would
    // order them arbitrarily and could delete s12, the one just written.
    const sessions = [
      { name: 's9-a', mtimeMs: 500 },
      { name: 's12-c', mtimeMs: 500 },
      { name: 's10-b', mtimeMs: 500 },
    ]
    expect(selectSessionsToDelete(sessions, 1)).toEqual(['s10-b', 's9-a'])
    expect(selectSessionsToDelete(sessions, 2)).toEqual(['s9-a'])
  })

  it('sorts foreign directory names last when mtimes tie', () => {
    const sessions = [
      { name: 'unrelated', mtimeMs: 700 },
      { name: 's4-keep', mtimeMs: 700 },
    ]
    expect(selectSessionsToDelete(sessions, 1)).toEqual(['unrelated'])
  })
})

describe('sessionSeq', () => {
  it('parses our own session names and rejects everything else', () => {
    expect(sessionSeq('s7-abc123')).toBe(7)
    expect(sessionSeq('s0-abc')).toBe(0)
    expect(sessionSeq('unrelated')).toBe(-1)
    expect(sessionSeq('s-abc')).toBe(-1)
    expect(sessionSeq('sNaN-abc')).toBe(-1)
  })
})

describe('isStaleSession', () => {
  it('flags sessions untouched for more than 24h', () => {
    expect(isStaleSession(1_000, 1_000 + MATERIALIZE_STALE_MS + 1)).toBe(true)
  })

  it('keeps sessions exactly at or under the threshold', () => {
    expect(isStaleSession(1_000, 1_000 + MATERIALIZE_STALE_MS)).toBe(false)
    expect(isStaleSession(1_000, 1_000)).toBe(false)
  })
})
