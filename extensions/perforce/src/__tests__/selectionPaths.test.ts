import { describe, expect, it, vi } from 'vitest'

// extension.ts pulls in the whole extension surface at import time; stub the API
// so importing the pure `selectionPaths` helper doesn't require the real host.
vi.mock('@universe-editor/extension-api', () => ({
  commands: { registerCommand: vi.fn(), executeCommand: vi.fn() },
  workspace: { getConfiguration: vi.fn(), rootPath: undefined },
  window: {},
}))

import {
  expandDirectoryTargets,
  reconcileUsesSelection,
  selectionPaths,
  selectionTargets,
} from '../extension.js'

describe('selectionPaths', () => {
  it('extracts resource paths from a multi-selection array', () => {
    expect(
      selectionPaths([
        { resourceUri: 'D:/w/a.txt', scmResourceGroupId: 'default' },
        { resourceUri: 'D:/w/b.txt', scmResourceGroupId: 'default' },
      ]),
    ).toEqual(['D:/w/a.txt', 'D:/w/b.txt'])
  })

  it('drops entries without a resourceUri', () => {
    expect(
      selectionPaths([{ resourceUri: 'D:/w/a.txt' }, { scmResourceGroupId: 'cl:5' }, {}]),
    ).toEqual(['D:/w/a.txt'])
  })

  it('returns [] for a non-array or empty selection', () => {
    expect(selectionPaths(undefined)).toEqual([])
    expect(selectionPaths([])).toEqual([])
    expect(selectionPaths({ resourceUri: 'D:/w/a.txt' })).toEqual([])
  })
})

describe('selectionTargets', () => {
  it('resolves Explorer `{ resource }` entries to fs paths, stripping the URI leading slash', () => {
    expect(
      selectionTargets([{ resource: { scheme: 'file', path: '/D:/w/a.txt' }, isDirectory: false }]),
    ).toEqual([{ path: 'D:/w/a.txt', isDirectory: false }])
  })

  it('carries isDirectory true through', () => {
    expect(
      selectionTargets([{ resource: { scheme: 'file', path: '/D:/w/dir' }, isDirectory: true }]),
    ).toEqual([{ path: 'D:/w/dir', isDirectory: true }])
  })

  it('drops non-file schemes', () => {
    expect(selectionTargets([{ resource: { scheme: 'untitled', path: '/x' } }])).toEqual([])
  })

  it('accepts the SCM `{ resourceUri }` form (no directory flag)', () => {
    expect(selectionTargets([{ resourceUri: '/w/b.txt' }])).toEqual([
      { path: '/w/b.txt', isDirectory: false },
    ])
  })

  it('returns [] for a non-array or empty selection', () => {
    expect(selectionTargets(undefined)).toEqual([])
    expect(selectionTargets([])).toEqual([])
    expect(selectionTargets({ resourceUri: '/w/b.txt' })).toEqual([])
  })
})

describe('expandDirectoryTargets', () => {
  it('expands directory entries to `<dir>/...` and leaves files alone', () => {
    expect(expandDirectoryTargets(['a/b', 'a/b/c.txt'], new Set(['a/b']))).toEqual([
      'a/b/...',
      'a/b/c.txt',
    ])
  })

  it('strips a trailing slash before appending /...', () => {
    expect(expandDirectoryTargets(['a/b/', 'a/b/c.txt'], new Set(['a/b/']))).toEqual([
      'a/b/...',
      'a/b/c.txt',
    ])
  })

  it('passes non-directory entries through unchanged', () => {
    expect(expandDirectoryTargets(['a/b/c.txt'], new Set())).toEqual(['a/b/c.txt'])
  })
})

describe('reconcileUsesSelection', () => {
  const file = (path: string) => ({ path, isDirectory: false })
  const dir = (path: string) => ({ path, isDirectory: true })

  it.each([
    // [label, selection, arg0IsDirectory, expected]
    ['no selection falls back to the primary target', [], false, false],
    ['no selection on a directory keeps the recursive filespec', [], true, false],
    ['Explorer all-files multi-select', [file('a'), file('b')], false, true],
    ['Explorer single-file right-click (selection = [primary])', [file('a')], false, true],
    ['Explorer mixed file+dir selection', [dir('d'), file('a')], true, true],
    ['Explorer directory right-click (selection contains the dir)', [dir('d')], true, true],
    // The one case that must NOT fan out: an SCM folder row passes the subtree's
    // opened files as the selection — enumerating them would drop files p4
    // hasn't seen, so the folder keeps its single `<dir>/...` filespec.
    ['SCM folder row (dir primary + all-files selection)', [file('d/a'), file('d/b')], true, false],
    ['SCM folder row with an empty subtree', [], true, false],
  ])('%s', (_label, selection, arg0IsDirectory, expected) => {
    expect(reconcileUsesSelection(selection, arg0IsDirectory)).toBe(expected)
  })
})
