import { describe, expect, it } from 'vitest'
import { isControlled, parseFstat, parseFstatRecord } from '../fstatParser.js'

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
