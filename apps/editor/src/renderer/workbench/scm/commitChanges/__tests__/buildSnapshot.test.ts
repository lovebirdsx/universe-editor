/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { CommitChangesFileEntry } from '@universe-editor/extensions-common'
import {
  buildCommitChangesSnapshot,
  findFileNode,
  type CommitChangesNode,
} from '../buildSnapshot.js'

function entry(path: string, overrides?: Partial<CommitChangesFileEntry>): CommitChangesFileEntry {
  return { path, oldPath: null, status: 'M', resourceUri: null, args: { path }, ...overrides }
}

function flatten(snapshot: ReturnType<typeof buildCommitChangesSnapshot>): CommitChangesNode[] {
  const out: CommitChangesNode[] = []
  const visit = (nodes: readonly CommitChangesNode[]): void => {
    for (const node of nodes) {
      out.push(node)
      visit(snapshot.childrenMap.get(node.id) ?? [])
    }
  }
  visit(snapshot.roots)
  return out
}

describe('buildCommitChangesSnapshot', () => {
  it('flattens top-level files into root rows', () => {
    const snapshot = buildCommitChangesSnapshot([entry('a.ts'), entry('b.ts')], new Set())

    expect(snapshot.roots.map((n) => n.id)).toEqual(['file:a.ts', 'file:b.ts'])
    expect(snapshot.childrenMap.size).toBe(0)
  })

  it('builds a folder tree for nested paths, folders first and alphabetical', () => {
    const snapshot = buildCommitChangesSnapshot(
      [entry('z.ts'), entry('src/b.ts'), entry('src/a.ts'), entry('lib/c.ts')],
      new Set(),
    )

    expect(snapshot.roots.map((n) => n.id)).toEqual(['folder:lib', 'folder:src', 'file:z.ts'])
    const srcChildren = snapshot.childrenMap.get('folder:src')!
    expect(srcChildren.map((n) => n.id)).toEqual(['file:src/a.ts', 'file:src/b.ts'])
    expect(snapshot.parentMap.get('file:src/a.ts')?.id).toBe('folder:src')
  })

  it('compacts a single-subfolder chain into one folder row', () => {
    const snapshot = buildCommitChangesSnapshot([entry('a/b/c/file.ts')], new Set())

    expect(snapshot.roots).toHaveLength(1)
    const folder = snapshot.roots[0]!
    expect(folder.kind).toBe('folder')
    if (folder.kind !== 'folder') return
    expect(folder.name).toBe('a/b/c')
    expect(folder.path).toBe('a/b/c')
    expect(snapshot.childrenMap.get(folder.id)?.map((n) => n.id)).toEqual(['file:a/b/c/file.ts'])
  })

  it('keeps chain levels separate when an intermediate folder holds files', () => {
    const snapshot = buildCommitChangesSnapshot(
      [entry('a/keep.ts'), entry('a/b/c/file.ts')],
      new Set(),
    )

    const a = snapshot.roots[0]!
    expect(a.id).toBe('folder:a')
    const aChildren = snapshot.childrenMap.get(a.id)!
    // Folder first, then the file.
    expect(aChildren.map((n) => n.id)).toEqual(['folder:a/b/c', 'file:a/keep.ts'])
  })

  it('carries the original entry (status / oldPath / resourceUri / args) on file rows', () => {
    const renamed = entry('src/new.ts', {
      oldPath: 'src/old.ts',
      status: 'R',
      resourceUri: 'file:///ws/src/new.ts',
      args: { commit: 'a1b2c3d', path: 'src/new.ts' },
    })
    const snapshot = buildCommitChangesSnapshot([renamed], new Set())

    const folder = snapshot.roots[0]!
    expect(folder.id).toBe('folder:src')
    const row = snapshot.childrenMap.get(folder.id)![0]!
    expect(row.kind).toBe('file')
    if (row.kind !== 'file') return
    expect(row.entry).toBe(renamed)
    expect(row.entry.oldPath).toBe('src/old.ts')
  })

  it('omits the dir suffix in tree mode — the folder rows already express the path', () => {
    const snapshot = buildCommitChangesSnapshot([entry('src/a.ts'), entry('b.ts')], new Set())

    for (const node of flatten(snapshot)) {
      if (node.kind === 'file') expect(node.dir).toBeUndefined()
    }
  })

  it('list mode flattens all files into sorted roots with a dir suffix', () => {
    const snapshot = buildCommitChangesSnapshot(
      [entry('z.ts'), entry('src/b.ts'), entry('src/a.ts'), entry('lib/c.ts')],
      new Set(),
      'list',
    )

    expect(snapshot.roots.map((n) => n.id)).toEqual([
      'file:lib/c.ts',
      'file:src/a.ts',
      'file:src/b.ts',
      'file:z.ts',
    ])
    expect(snapshot.childrenMap.size).toBe(0)
    const nested = snapshot.roots[1]!
    expect(nested.kind === 'file' && nested.dir).toBe('src')
    const topLevel = snapshot.roots[3]!
    expect(topLevel.kind === 'file' ? topLevel.dir : 'x').toBeUndefined()
  })

  it('list mode ignores the collapsed set', () => {
    const snapshot = buildCommitChangesSnapshot(
      [entry('src/a.ts'), entry('src/b.ts')],
      new Set(['src']),
      'list',
    )

    expect(snapshot.roots.map((n) => n.id)).toEqual(['file:src/a.ts', 'file:src/b.ts'])
  })

  it('omits children of collapsed folders but keeps the folder row', () => {
    const snapshot = buildCommitChangesSnapshot(
      [entry('src/a.ts'), entry('src/deep/b.ts'), entry('top.ts')],
      new Set(['src']),
    )

    expect(snapshot.roots.map((n) => n.id)).toEqual(['folder:src', 'file:top.ts'])
    expect(snapshot.childrenMap.get('folder:src')).toBeUndefined()
    expect(flatten(snapshot).map((n) => n.id)).toEqual(['folder:src', 'file:top.ts'])
  })

  it('collapses only the named folder, nested folders stay expandable', () => {
    const snapshot = buildCommitChangesSnapshot(
      [entry('src/deep/a.ts'), entry('src/deep/deeper/b.ts')],
      new Set(['src/deep']),
    )

    // The chain src → deep compacts because src has no files and one subfolder.
    const folder = snapshot.roots[0]!
    expect(folder.id).toBe('folder:src/deep')
    expect(snapshot.childrenMap.get(folder.id)).toBeUndefined()
  })

  it('sorts files alphabetically within a folder', () => {
    const snapshot = buildCommitChangesSnapshot(
      [entry('src/z.ts'), entry('src/a.ts'), entry('src/m.ts')],
      new Set(),
    )

    expect(snapshot.childrenMap.get('folder:src')!.map((n) => n.id)).toEqual([
      'file:src/a.ts',
      'file:src/m.ts',
      'file:src/z.ts',
    ])
  })

  it('findFileNode locates a file row by entry path', () => {
    const snapshot = buildCommitChangesSnapshot([entry('src/a.ts'), entry('lib/b.ts')], new Set())

    expect(findFileNode(snapshot, 'lib/b.ts')?.entry.path).toBe('lib/b.ts')
    expect(findFileNode(snapshot, 'missing.ts')).toBeUndefined()
  })

  it('findFileNode locates a file row in list mode', () => {
    const snapshot = buildCommitChangesSnapshot(
      [entry('src/a.ts'), entry('lib/b.ts')],
      new Set(),
      'list',
    )

    expect(findFileNode(snapshot, 'lib/b.ts')?.entry.path).toBe('lib/b.ts')
    expect(findFileNode(snapshot, 'missing.ts')).toBeUndefined()
  })
})
