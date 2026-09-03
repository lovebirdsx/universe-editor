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
  filterReconcileTargets,
  isRevertDirectoryTarget,
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

describe('isRevertDirectoryTarget', () => {
  const file = (path: string) => ({ path, isDirectory: false })
  const dir = (path: string) => ({ path, isDirectory: true })

  it('selection of exactly the one directory (Explorer directory right-click) → true', () => {
    expect(isRevertDirectoryTarget([dir('X:/p4ws/main/sub')], true)).toBe(true)
  })

  it('no selection with a directory primary (old hosts / fallback) → true', () => {
    expect(isRevertDirectoryTarget([], true)).toBe(true)
  })

  it('no selection with a file primary → false', () => {
    expect(isRevertDirectoryTarget([], false)).toBe(false)
  })

  it('single file selection → false', () => {
    expect(isRevertDirectoryTarget([file('X:/p4ws/main/a.txt')], false)).toBe(false)
  })

  it('mixed directory + file selection → false (handled by the multi-select merge path)', () => {
    expect(
      isRevertDirectoryTarget([dir('X:/p4ws/main/sub'), file('X:/p4ws/main/a.txt')], true),
    ).toBe(false)
  })

  it('two directories → false (multi-select merge path, not the single-directory branch)', () => {
    expect(isRevertDirectoryTarget([dir('X:/p4ws/main/a'), dir('X:/p4ws/main/b')], true)).toBe(
      false,
    )
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

describe('filterReconcileTargets', () => {
  const file = (path: string) => ({ path, isDirectory: false })
  const dir = (path: string) => ({ path, isDirectory: true })

  it('keeps targets whose path is not excluded', () => {
    const targets = [file('a.txt'), file('b.txt'), dir('d')]
    expect(filterReconcileTargets(targets, (p) => p === 'b.txt')).toEqual([file('a.txt'), dir('d')])
  })

  it('drops every target when all are excluded', () => {
    const targets = [file('a.txt'), file('b.txt')]
    expect(filterReconcileTargets(targets, () => true)).toEqual([])
  })

  it('returns [] for an empty array', () => {
    expect(filterReconcileTargets([], () => false)).toEqual([])
  })

  it('filters directory targets by their own path too', () => {
    const targets = [file('a.txt'), dir('gen')]
    expect(filterReconcileTargets(targets, (p) => p === 'gen')).toEqual([file('a.txt')])
  })
})
