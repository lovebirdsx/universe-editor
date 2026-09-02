import { describe, expect, it } from 'vitest'
import { asRev, fstatBehind, isControlled, parseFstat, parseFstatRecord } from '../fstatParser.js'
import type { FstatInfo } from '../fstatParser.js'

describe('parseFstatRecord', () => {
  it('maps a plain fstat record without an unresolved key to unresolved: false', () => {
    const info = parseFstatRecord({
      depotFile: '//depot/branch_x/a.txt',
      clientFile: 'X:/p4ws/main/a.txt',
      haveRev: '3',
      headRev: '7',
    })
    expect(info).toEqual({
      depotFile: '//depot/branch_x/a.txt',
      clientFile: 'X:/p4ws/main/a.txt',
      haveRev: '3',
      headRev: '7',
      action: undefined,
      unresolved: false,
    })
  })

  it('reads the bare unresolved key as true (presence, not value — -Mj and -ztag both collapse to an empty-string value)', () => {
    // PROBE-FINDINGS §11.5: only fstat carries the unresolved signal; the key is
    // bare (`... unresolved` under -ztag, `"unresolved": ""` under -Mj) and the
    // value is always empty, so presence alone decides.
    const info = parseFstatRecord({
      depotFile: '//depot/branch_x/a.txt',
      clientFile: 'X:/p4ws/main/a.txt',
      unresolved: '',
    })
    expect(info?.unresolved).toBe(true)
  })

  it('returns undefined for a record with no depot path', () => {
    // `fstat -Ru` with no opened files answers "file(s) not opened on this
    // client." — must never parse into a phantom unresolved record.
    expect(parseFstatRecord({ '-': 'file(s) not opened on this client.' })).toBeUndefined()
  })
})

describe('parseFstat', () => {
  it('keeps only depot records and carries the unresolved signal through', () => {
    const files = parseFstat([
      {
        depotFile: '//depot/branch_x/a.txt',
        clientFile: 'X:/p4ws/main/a.txt',
        unresolved: '',
      },
      { '-': 'file(s) not opened on this client.' },
      { depotFile: '//depot/branch_x/b.txt', clientFile: 'X:/p4ws/main/b.txt' },
    ])
    expect(files.map((f) => [f.depotFile, f.unresolved])).toEqual([
      ['//depot/branch_x/a.txt', true],
      ['//depot/branch_x/b.txt', false],
    ])
  })

  it('returns an empty list for empty output', () => {
    expect(parseFstat([])).toEqual([])
  })
})

describe('isControlled', () => {
  it('is true when any record carries a depot path', () => {
    expect(isControlled([{ depotFile: '//depot/branch_x/a.txt' }])).toBe(true)
  })

  it('is false for records without a depot path', () => {
    expect(isControlled([{ '-': 'no such file(s).' }])).toBe(false)
  })
})

function info(overrides: Partial<FstatInfo>): FstatInfo {
  return {
    depotFile: '//depot/branch_x/a.txt',
    clientFile: 'X:/p4ws/main/a.txt',
    haveRev: undefined,
    headRev: undefined,
    action: undefined,
    unresolved: false,
    ...overrides,
  }
}

describe('asRev', () => {
  it('parses a plain revision string', () => {
    expect(asRev('7')).toBe(7)
  })

  it('returns undefined for "none" (open-for-add has no have revision)', () => {
    expect(asRev('none')).toBeUndefined()
  })

  it('returns undefined for missing or non-integer values rather than NaN', () => {
    expect(asRev(undefined)).toBeUndefined()
    expect(asRev('')).toBeUndefined()
    expect(asRev('abc')).toBeUndefined()
    expect(asRev('1.5')).toBeUndefined()
  })
})

describe('fstatBehind', () => {
  it('is behind with the headRev when have < head', () => {
    expect(fstatBehind(info({ haveRev: '3', headRev: '7' }))).toEqual({
      behind: true,
      headRev: '7',
    })
  })

  it('is not behind when have equals or exceeds head', () => {
    expect(fstatBehind(info({ haveRev: '7', headRev: '7' })).behind).toBe(false)
    expect(fstatBehind(info({ haveRev: '8', headRev: '7' })).behind).toBe(false)
  })

  it('excludes open-for-add: action add even when have < head', () => {
    expect(fstatBehind(info({ action: 'add', haveRev: '3', headRev: '7' })).behind).toBe(false)
  })

  it('excludes open-for-add: haveRev "none"', () => {
    // A new file has no have revision to be behind (PROBE-FINDINGS §10).
    expect(fstatBehind(info({ haveRev: 'none', headRev: '7' })).behind).toBe(false)
  })

  it('is not behind when either revision is missing or unparseable', () => {
    expect(fstatBehind(info({ haveRev: undefined, headRev: '7' })).behind).toBe(false)
    expect(fstatBehind(info({ haveRev: '3', headRev: undefined })).behind).toBe(false)
    expect(fstatBehind(info({ haveRev: '3', headRev: 'abc' })).behind).toBe(false)
  })
})
