import { describe, expect, it } from 'vitest'
import {
  parseChangesList,
  parseChangeDescribe,
  statusFromAction,
  fileDiffRevs,
  parseWhereLocalPaths,
  displayPath,
} from '../p4GraphParser.js'

describe('parseChangesList', () => {
  it('parses submitted change metadata', () => {
    const changes = parseChangesList([
      {
        change: '4521',
        user: 'alice',
        client: 'alice-ws',
        time: '1700000000',
        desc: 'Fix the widget\nlong body ignored',
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
      },
      { id: '4519', author: 'bob', client: 'bob-ws', date: 1699990000, message: 'Initial' },
    ])
  })

  it('skips records without a change id and defaults empty fields', () => {
    const changes = parseChangesList([{ user: 'x' }, { change: '7' }])
    expect(changes).toEqual([{ id: '7', author: '', client: '', date: 0, message: '' }])
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
