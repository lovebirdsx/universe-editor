import { describe, expect, it } from 'vitest'
import {
  expandDismissPaths,
  filterDismissed,
  mergeReconcile,
  parseReconcile,
  parseReconcileRecord,
} from '../reconcileParser.js'
import type { ReconcileFile } from '../reconcileParser.js'

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
      { depotFile: '//depot/Src/a.ts', clientFile: '//aki_ws/Src/a.ts', action: 'edit', rev: '2' },
      'G:/aki_3.6',
    )
    expect(file?.clientFile).toBe('G:/aki_3.6/Src/a.ts')
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

describe('mergeReconcile', () => {
  const edit = (p: string): ReconcileFile => ({
    depotFile: `//depot/${p}`,
    clientFile: `D:/work/${p}`,
    action: 'edit',
    rev: '1',
  })

  it('carries over prior entries whose path was not re-scanned', () => {
    const prev = [edit('a.txt'), edit('b.txt')]
    const merged = mergeReconcile(prev, ['D:/work/a.txt'], [edit('a.txt')])
    expect(merged.map((f) => f.clientFile)).toEqual(['D:/work/a.txt', 'D:/work/b.txt'])
  })

  it('drops a re-scanned path that came back clean (absent from fresh)', () => {
    const prev = [edit('a.txt'), edit('b.txt')]
    const merged = mergeReconcile(prev, ['D:/work/a.txt'], [])
    expect(merged.map((f) => f.clientFile)).toEqual(['D:/work/b.txt'])
  })

  it('adds a freshly discovered path not seen before', () => {
    const merged = mergeReconcile([edit('a.txt')], ['D:/work/c.txt'], [edit('c.txt')])
    expect(merged.map((f) => f.clientFile).sort()).toEqual(['D:/work/a.txt', 'D:/work/c.txt'])
  })

  it('dedupes by normalized clientFile, fresh winning over prior', () => {
    const prevAdd: ReconcileFile = {
      depotFile: '//depot/a.txt',
      clientFile: 'D:/work/a.txt',
      action: 'add',
      rev: undefined,
    }
    const merged = mergeReconcile([prevAdd], ['d:/WORK/a.txt'], [edit('a.txt')])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.action).toBe('edit')
  })
})

describe('filterDismissed', () => {
  const edit = (p: string): ReconcileFile => ({
    depotFile: `//depot/${p}`,
    clientFile: `D:/work/${p}`,
    action: 'edit',
    rev: '1',
  })

  it('returns a copy unchanged when nothing is dismissed', () => {
    const files = [edit('a.txt'), edit('b.txt')]
    expect(filterDismissed(files, new Set())).toEqual(files)
  })

  it('drops files whose normalized path is dismissed', () => {
    const files = [edit('a.txt'), edit('b.txt')]
    const dismissed = new Set(['d:/work/a.txt'])
    expect(filterDismissed(files, dismissed).map((f) => f.clientFile)).toEqual(['D:/work/b.txt'])
  })

  it('keeps entries without a local path (can’t be keyed)', () => {
    const noPath: ReconcileFile = {
      depotFile: '//depot/x.txt',
      clientFile: undefined,
      action: 'edit',
      rev: '1',
    }
    expect(filterDismissed([noPath], new Set(['whatever']))).toEqual([noPath])
  })
})

describe('expandDismissPaths', () => {
  const edit = (p: string): ReconcileFile => ({
    depotFile: `//depot/${p}`,
    clientFile: `D:/work/${p}`,
    action: 'edit',
    rev: '1',
  })

  it('returns the file itself for an exact listed target', () => {
    const files = [edit('a.txt'), edit('sub/b.txt')]
    expect(expandDismissPaths(['D:/work/a.txt'], files)).toEqual(['d:/work/a.txt'])
  })

  it('expands a directory target into every listed file under it', () => {
    const files = [edit('sub/b.txt'), edit('sub/deep/c.txt'), edit('other.txt')]
    expect(expandDismissPaths(['D:/work/sub'], files).sort()).toEqual([
      'd:/work/sub/b.txt',
      'd:/work/sub/deep/c.txt',
    ])
  })

  it('dedupes overlapping file + directory targets', () => {
    const files = [edit('sub/b.txt')]
    expect(expandDismissPaths(['D:/work/sub', 'D:/work/sub/b.txt'], files)).toEqual([
      'd:/work/sub/b.txt',
    ])
  })

  it('yields nothing for a directory with no listed files under it', () => {
    expect(expandDismissPaths(['D:/work/empty'], [edit('a.txt')])).toEqual([])
  })
})
