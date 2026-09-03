import { describe, expect, it } from 'vitest'
import {
  parseChangesList,
  parseChangeDescribe,
  statusFromAction,
  fileDiffRevs,
  parseWhereLocalPaths,
  displayPath,
  openedUnderAnyScope,
  dedupeChangesNewestFirst,
} from '../p4GraphParser.js'

describe('parseChangesList', () => {
  it('parses submitted change metadata', () => {
    const changes = parseChangesList([
      {
        change: '4521',
        user: 'alice',
        client: 'alice-ws',
        time: '1700000000',
        desc: 'Fix the widget\nwith a longer explanation',
      },
      { change: '4519', user: 'bob', client: 'bob-ws', time: '1699990000', desc: 'Initial' },
    ])
    expect(changes).toEqual([
      {
        id: '4521',
        author: 'alice',
        client: 'alice-ws',
        date: 1700000000,
        message: 'Fix the widget',
        body: 'Fix the widget\nwith a longer explanation',
      },
      {
        id: '4519',
        author: 'bob',
        client: 'bob-ws',
        date: 1699990000,
        message: 'Initial',
        body: 'Initial',
      },
    ])
  })

  it('skips records without a change id and defaults empty fields', () => {
    const changes = parseChangesList([{ user: 'x' }, { change: '7' }])
    expect(changes).toEqual([{ id: '7', author: '', client: '', date: 0, message: '', body: '' }])
  })
})

describe('parseChangeDescribe', () => {
  it('folds parallel keys into files and trims the body', () => {
    const detail = parseChangeDescribe({
      change: '4521',
      user: 'alice',
      client: 'alice-ws',
      time: '1700000000',
      desc: 'Fix the widget\nmore detail\n\n',
      depotFile0: '//depot/main/a.txt',
      action0: 'edit',
      rev0: '3',
      depotFile1: '//depot/main/b.txt',
      action1: 'add',
      rev1: '1',
    })
    expect(detail).toEqual({
      id: '4521',
      author: 'alice',
      client: 'alice-ws',
      date: 1700000000,
      body: 'Fix the widget\nmore detail',
      files: [
        { depotFile: '//depot/main/a.txt', action: 'edit', rev: '3' },
        { depotFile: '//depot/main/b.txt', action: 'add', rev: '1' },
      ],
    })
  })

  it('returns undefined without a change id', () => {
    expect(parseChangeDescribe({ desc: 'x' })).toBeUndefined()
  })
})

describe('statusFromAction', () => {
  it('maps p4 actions to status letters', () => {
    expect(statusFromAction('add')).toBe('A')
    expect(statusFromAction('branch')).toBe('A')
    expect(statusFromAction('delete')).toBe('D')
    expect(statusFromAction('move/delete')).toBe('D')
    expect(statusFromAction('move/add')).toBe('R')
    expect(statusFromAction('edit')).toBe('M')
    expect(statusFromAction('integrate')).toBe('M')
  })
})

describe('fileDiffRevs', () => {
  it('added file diffs against nothing', () => {
    expect(fileDiffRevs('//depot/a', 'A', '1')).toEqual({ left: null, right: '//depot/a#1' })
  })

  it('edited file diffs previous vs current revision', () => {
    expect(fileDiffRevs('//depot/a', 'M', '3')).toEqual({
      left: '//depot/a#2',
      right: '//depot/a#3',
    })
  })

  it('deleted file diffs previous revision vs nothing', () => {
    expect(fileDiffRevs('//depot/a', 'D', '5')).toEqual({
      left: '//depot/a#4',
      right: null,
    })
  })

  it('first-revision edit has no base', () => {
    expect(fileDiffRevs('//depot/a', 'M', '1')).toEqual({ left: null, right: '//depot/a#1' })
  })
})

describe('parseWhereLocalPaths', () => {
  it('maps depot files to local paths, skipping error records', () => {
    const map = parseWhereLocalPaths([
      { depotFile: '//depot/a', clientFile: '//ws/a', path: 'C:/ws/a' },
      { depotFile: '//depot/b' }, // not in view — no path
    ])
    expect(map.get('//depot/a')).toBe('C:/ws/a')
    expect(map.has('//depot/b')).toBe(false)
  })
})

describe('displayPath', () => {
  it('strips the leading depot slashes', () => {
    expect(displayPath('//depot/main/a.txt')).toBe('depot/main/a.txt')
  })
})

describe('openedUnderAnyScope', () => {
  const opened: { clientFile: string | undefined }[] = [
    { clientFile: 'X:/p4ws/main/A/x.txt' },
    { clientFile: 'X:/p4ws/main/A/deep/y.txt' },
    { clientFile: 'X:/p4ws/main/AB/z.txt' },
    { clientFile: 'X:/p4ws/main/root.txt' },
    { clientFile: undefined },
  ]

  it('matches a directory scope recursively', () => {
    const out = openedUnderAnyScope(opened, [{ path: 'X:/p4ws/main/A', isDirectory: true }])
    expect(out.map((f) => f.clientFile)).toEqual([
      'X:/p4ws/main/A/x.txt',
      'X:/p4ws/main/A/deep/y.txt',
    ])
  })

  it('matches a file scope exactly', () => {
    const out = openedUnderAnyScope(opened, [{ path: 'X:/p4ws/main/root.txt', isDirectory: false }])
    expect(out.map((f) => f.clientFile)).toEqual(['X:/p4ws/main/root.txt'])
  })

  it('unions several scopes, each entry at most once', () => {
    const out = openedUnderAnyScope(opened, [
      { path: 'X:/p4ws/main/A', isDirectory: true },
      { path: 'X:/p4ws/main/root.txt', isDirectory: false },
      // Overlaps the directory scope above — must not duplicate its entry.
      { path: 'X:/p4ws/main/A/x.txt', isDirectory: false },
    ])
    expect(out.map((f) => f.clientFile)).toEqual([
      'X:/p4ws/main/A/x.txt',
      'X:/p4ws/main/A/deep/y.txt',
      'X:/p4ws/main/root.txt',
    ])
  })

  it('keeps nothing for an empty scope list', () => {
    expect(openedUnderAnyScope(opened, [])).toEqual([])
  })

  it('respects the directory boundary (A never matches AB)', () => {
    const out = openedUnderAnyScope(opened, [{ path: 'X:/p4ws/main/A', isDirectory: true }])
    expect(out.some((f) => f.clientFile === 'X:/p4ws/main/AB/z.txt')).toBe(false)
  })

  it('drops entries without a clientFile', () => {
    const out = openedUnderAnyScope(
      [{ clientFile: undefined }, { clientFile: 'X:/p4ws/main/A/x.txt' }],
      [{ path: 'X:/p4ws/main/A', isDirectory: true }],
    )
    expect(out).toEqual([{ clientFile: 'X:/p4ws/main/A/x.txt' }])
  })

  it('follows the host case policy for path segments', () => {
    const insensitive = process.platform === 'win32' || process.platform === 'darwin'
    const out = openedUnderAnyScope(
      [{ clientFile: 'X:/p4ws/MAIN/a.txt' }],
      [{ path: 'X:/p4ws/main', isDirectory: true }],
    )
    expect(out.length).toBe(insensitive ? 1 : 0)
    const fileOut = openedUnderAnyScope(
      [{ clientFile: 'X:/p4ws/MAIN/a.txt' }],
      [{ path: 'X:/p4ws/main/a.txt', isDirectory: false }],
    )
    expect(fileOut.length).toBe(insensitive ? 1 : 0)
  })
})

describe('dedupeChangesNewestFirst', () => {
  const meta = (id: string) => ({
    id,
    author: 'testuser',
    client: 'ws',
    date: 1,
    message: `m${id}`,
    body: `m${id}`,
  })

  it('drops repeats of the same changelist (one CL touching several filespecs)', () => {
    const out = dedupeChangesNewestFirst([meta('4522'), meta('4521'), meta('4522')])
    expect(out.map((c) => c.id)).toEqual(['4522', '4521'])
  })

  it('re-sorts numerically newest-first even when the union arrives interleaved', () => {
    const out = dedupeChangesNewestFirst([meta('99'), meta('4521'), meta('100'), meta('4522')])
    expect(out.map((c) => c.id)).toEqual(['4522', '4521', '100', '99'])
  })
})
