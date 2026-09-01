import { describe, expect, it } from 'vitest'
import { parseReconcile, parseReconcileRecord } from '../reconcileParser.js'

describe('parseReconcileRecord', () => {
  it('maps a locally edited (unopened) file to edit', () => {
    const file = parseReconcileRecord({
      depotFile: '//depot/a.txt',
      clientFile: 'D:/work/a.txt',
      action: 'edit',
      rev: '3',
    })
    expect(file).toEqual({
      depotFile: '//depot/a.txt',
      clientFile: 'D:/work/a.txt',
      action: 'edit',
      rev: '3',
    })
  })

  it('maps a newly created file to add (no rev)', () => {
    const file = parseReconcileRecord({
      depotFile: '//depot/new.txt',
      clientFile: 'D:/work/new.txt',
      action: 'add',
    })
    expect(file?.action).toBe('add')
    expect(file?.rev).toBeUndefined()
  })

  it('maps a file deleted on disk to delete', () => {
    const file = parseReconcileRecord({
      depotFile: '//depot/gone.txt',
      clientFile: 'D:/work/gone.txt',
      action: 'delete',
      rev: '7',
    })
    expect(file?.action).toBe('delete')
    expect(file?.rev).toBe('7')
  })

  it('normalizes an unknown action to edit', () => {
    const file = parseReconcileRecord({
      depotFile: '//depot/w.txt',
      clientFile: 'D:/work/w.txt',
      action: 'weird',
    })
    expect(file?.action).toBe('edit')
  })

  it('returns undefined for a record with no depot path', () => {
    expect(parseReconcileRecord({ action: 'edit' })).toBeUndefined()
  })

  it('tolerates a missing clientFile', () => {
    const file = parseReconcileRecord({ depotFile: '//depot/x.txt', action: 'edit' })
    expect(file?.clientFile).toBeUndefined()
  })

  // Same client-syntax gotcha as `p4 opened`: `reconcile -n` reports `clientFile`
  // in client syntax; with a clientRoot it must become the local path.
  it('translates a client-syntax clientFile onto the client root', () => {
    const file = parseReconcileRecord(
      {
        depotFile: '//depot/Src/a.ts',
        clientFile: '//ws/Src/a.ts',
        action: 'edit',
        rev: '2',
      },
      'G:/p4ws/main',
    )
    expect(file?.clientFile).toBe('G:/p4ws/main/Src/a.ts')
  })
})

describe('parseReconcile', () => {
  it('parses many records and drops non-file ones', () => {
    const files = parseReconcile([
      { depotFile: '//depot/a.txt', clientFile: 'D:/work/a.txt', action: 'edit', rev: '1' },
      { info: 'no such file(s).' },
      { depotFile: '//depot/b.txt', clientFile: 'D:/work/b.txt', action: 'add' },
    ])
    expect(files).toHaveLength(2)
    expect(files.map((f) => f.action)).toEqual(['edit', 'add'])
  })

  it('returns an empty list for empty output', () => {
    expect(parseReconcile([])).toEqual([])
  })
})
