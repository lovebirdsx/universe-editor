/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  buildChangesTreeSnapshot,
  findChangesTreeFileNode,
  type ChangesTreeItem,
  type ChangesTreeNode,
} from '../buildSnapshot.js'

interface FakeEntry {
  path: string
  status: string
}

function item(path: string, overrides?: Partial<FakeEntry>): ChangesTreeItem<FakeEntry> {
  const segments = path.split('/').filter((p) => p !== '')
  segments.pop()
  const i = path.lastIndexOf('/')
  return {
    path,
    dirSegments: segments,
    dir: i === -1 ? '' : path.slice(0, i),
    entry: { path, status: 'M', ...overrides },
  }
}

function flatten(
  snapshot: ReturnType<typeof buildChangesTreeSnapshot<FakeEntry>>,
): ChangesTreeNode<FakeEntry>[] {
  const out: ChangesTreeNode<FakeEntry>[] = []
  const visit = (nodes: readonly ChangesTreeNode<FakeEntry>[]): void => {
    for (const node of nodes) {
      out.push(node)
      visit(snapshot.childrenMap.get(node.id) ?? [])
    }
  }
  visit(snapshot.roots)
  return out
}

describe('buildChangesTreeSnapshot', () => {
  it('flattens top-level files into root rows', () => {
    const snapshot = buildChangesTreeSnapshot([item('a.ts'), item('b.ts')], new Set())

    expect(snapshot.roots.map((n) => n.id)).toEqual(['file:a.ts', 'file:b.ts'])
    expect(snapshot.childrenMap.size).toBe(0)
  })

  it('builds a folder tree for nested paths, folders first and alphabetical', () => {
    const snapshot = buildChangesTreeSnapshot(
      [item('z.ts'), item('src/b.ts'), item('src/a.ts'), item('lib/c.ts')],
      new Set(),
    )

    expect(snapshot.roots.map((n) => n.id)).toEqual(['folder:lib', 'folder:src', 'file:z.ts'])
    const srcChildren = snapshot.childrenMap.get('folder:src')!
    expect(srcChildren.map((n) => n.id)).toEqual(['file:src/a.ts', 'file:src/b.ts'])
    expect(snapshot.parentMap.get('file:src/a.ts')?.id).toBe('folder:src')
  })

  it('compacts a single-subfolder chain into one folder row', () => {
    const snapshot = buildChangesTreeSnapshot([item('a/b/c/file.ts')], new Set())

    expect(snapshot.roots).toHaveLength(1)
    const folder = snapshot.roots[0]!
    expect(folder.kind).toBe('folder')
    if (folder.kind !== 'folder') return
    expect(folder.name).toBe('a/b/c')
    expect(folder.path).toBe('a/b/c')
    expect(snapshot.childrenMap.get(folder.id)?.map((n) => n.id)).toEqual(['file:a/b/c/file.ts'])
  })

  it('keeps chain levels separate when an intermediate folder holds files', () => {
    const snapshot = buildChangesTreeSnapshot([item('a/keep.ts'), item('a/b/c/file.ts')], new Set())

    const a = snapshot.roots[0]!
    expect(a.id).toBe('folder:a')
    const aChildren = snapshot.childrenMap.get(a.id)!
    // Folder first, then the file.
    expect(aChildren.map((n) => n.id)).toEqual(['folder:a/b/c', 'file:a/keep.ts'])
  })

  it('carries the original entry on file rows', () => {
    const renamed = item('src/new.ts', { status: 'R' })
    const snapshot = buildChangesTreeSnapshot([renamed], new Set())

    const folder = snapshot.roots[0]!
    expect(folder.id).toBe('folder:src')
    const row = snapshot.childrenMap.get(folder.id)![0]!
    expect(row.kind).toBe('file')
    if (row.kind !== 'file') return
    expect(row.item).toBe(renamed)
    expect(row.item.entry.status).toBe('R')
  })

  it('omits the dir suffix in tree mode — the folder rows already express the path', () => {
    const snapshot = buildChangesTreeSnapshot([item('src/a.ts'), item('b.ts')], new Set())

    for (const node of flatten(snapshot)) {
      if (node.kind === 'file') expect(node.dir).toBeUndefined()
    }
  })

  it('list mode flattens all files into sorted roots with a dir suffix', () => {
    const snapshot = buildChangesTreeSnapshot(
      [item('z.ts'), item('src/b.ts'), item('src/a.ts'), item('lib/c.ts')],
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
    const snapshot = buildChangesTreeSnapshot(
      [item('src/a.ts'), item('src/b.ts')],
      new Set(['src']),
      'list',
    )

    expect(snapshot.roots.map((n) => n.id)).toEqual(['file:src/a.ts', 'file:src/b.ts'])
  })

  it('omits children of collapsed folders but keeps the folder row', () => {
    const snapshot = buildChangesTreeSnapshot(
      [item('src/a.ts'), item('src/deep/b.ts'), item('top.ts')],
      new Set(['src']),
    )

    expect(snapshot.roots.map((n) => n.id)).toEqual(['folder:src', 'file:top.ts'])
    expect(snapshot.childrenMap.get('folder:src')).toBeUndefined()
    expect(flatten(snapshot).map((n) => n.id)).toEqual(['folder:src', 'file:top.ts'])
  })

  it('collapses only the named folder, nested folders stay expandable', () => {
    const snapshot = buildChangesTreeSnapshot(
      [item('src/deep/a.ts'), item('src/deep/deeper/b.ts')],
      new Set(['src/deep']),
    )

    // The chain src → deep compacts because src has no files and one subfolder.
    const folder = snapshot.roots[0]!
    expect(folder.id).toBe('folder:src/deep')
    expect(snapshot.childrenMap.get(folder.id)).toBeUndefined()
  })

  it('sorts files alphabetically within a folder', () => {
    const snapshot = buildChangesTreeSnapshot(
      [item('src/z.ts'), item('src/a.ts'), item('src/m.ts')],
      new Set(),
    )

    expect(snapshot.childrenMap.get('folder:src')!.map((n) => n.id)).toEqual([
      'file:src/a.ts',
      'file:src/m.ts',
      'file:src/z.ts',
    ])
  })

  it('findChangesTreeFileNode locates a file row by item path', () => {
    const snapshot = buildChangesTreeSnapshot([item('src/a.ts'), item('lib/b.ts')], new Set())

    expect(findChangesTreeFileNode(snapshot, 'lib/b.ts')?.item.path).toBe('lib/b.ts')
    expect(findChangesTreeFileNode(snapshot, 'missing.ts')).toBeUndefined()
  })

  it('findChangesTreeFileNode locates a file row in list mode', () => {
    const snapshot = buildChangesTreeSnapshot(
      [item('src/a.ts'), item('lib/b.ts')],
      new Set(),
      'list',
    )

    expect(findChangesTreeFileNode(snapshot, 'lib/b.ts')?.item.path).toBe('lib/b.ts')
    expect(findChangesTreeFileNode(snapshot, 'missing.ts')).toBeUndefined()
  })
})
