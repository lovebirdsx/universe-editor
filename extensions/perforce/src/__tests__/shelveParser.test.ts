import { describe, expect, it } from 'vitest'
import { parseShelved } from '../shelveParser.js'

describe('parseShelved', () => {
  it('folds parallel numbered keys into shelved files', () => {
    const record = {
      change: '4521',
      depotFile0: '//depot/main/a.txt',
      depotFile1: '//depot/main/b.txt',
      rev0: '3',
      rev1: '7',
      action0: 'edit',
      action1: 'add',
    }
    const files = parseShelved([record])
    expect(files).toEqual([
      { depotFile: '//depot/main/a.txt', rev: '3', action: 'edit' },
      { depotFile: '//depot/main/b.txt', rev: '7', action: 'add' },
    ])
  })

  it('stops at the first missing index (parallel arrays end together)', () => {
    const files = parseShelved([
      { depotFile0: '//depot/x', depotFile1: '//depot/y', action0: 'delete' },
    ])
    expect(files.map((f) => f.depotFile)).toEqual(['//depot/x', '//depot/y'])
    expect(files[0]!.action).toBe('delete')
    // Second file has no action → normalized to edit.
    expect(files[1]!.action).toBe('edit')
  })

  it('returns empty for a record with no shelved files', () => {
    expect(parseShelved([{ change: '99', status: 'pending' }])).toEqual([])
  })

  it('normalizes an unknown action to edit', () => {
    const files = parseShelved([{ depotFile0: '//depot/z', action0: 'weird' }])
    expect(files[0]!.action).toBe('edit')
  })
})
