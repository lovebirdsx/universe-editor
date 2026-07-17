/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/search/searchTree.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI, type IFileMatch } from '@universe-editor/platform'
import { buildSearchSnapshot, type SearchNode } from '../searchTree.js'

function fileMatch(path: string, lines: { line: number; ranges: number }[]): IFileMatch {
  return {
    resource: URI.file(path).toJSON(),
    matches: lines.map((l) => ({
      lineNumber: l.line,
      preview: 'preview',
      ranges: Array.from({ length: l.ranges }, (_, i) => ({
        startColumn: i + 1,
        endColumn: i + 2,
      })),
    })),
  }
}

const root = URI.file('/ws')

describe('buildSearchSnapshot', () => {
  it('list mode: files at root, one match node per range', () => {
    const results = [
      fileMatch('/ws/a.ts', [{ line: 1, ranges: 2 }]),
      fileMatch('/ws/src/b.ts', [{ line: 3, ranges: 1 }]),
    ]
    const snap = buildSearchSnapshot(results, root, 'list')

    expect(snap.roots).toHaveLength(2)
    expect(snap.roots.every((n) => n.kind === 'file')).toBe(true)

    const fileA = snap.roots[0] as Extract<SearchNode, { kind: 'file' }>
    expect(fileA.name).toBe('a.ts')
    expect(fileA.matchCount).toBe(2)
    expect(fileA.relPath).toBe('a.ts')
    expect(snap.childrenMap.get(fileA.id)).toHaveLength(2)

    const fileB = snap.roots[1] as Extract<SearchNode, { kind: 'file' }>
    expect(fileB.relPath).toBe('src/b.ts')
  })

  it('tree mode: nests files under workspace-relative folders', () => {
    const results = [
      fileMatch('/ws/src/a.ts', [{ line: 1, ranges: 1 }]),
      fileMatch('/ws/src/sub/b.ts', [{ line: 2, ranges: 1 }]),
    ]
    const snap = buildSearchSnapshot(results, root, 'tree')

    expect(snap.roots).toHaveLength(1)
    const src = snap.roots[0] as Extract<SearchNode, { kind: 'folder' }>
    expect(src.kind).toBe('folder')
    expect(src.name).toBe('src')

    const srcChildren = snap.childrenMap.get(src.id) ?? []
    // src/sub (folder) + src/a.ts (file)
    expect(srcChildren.some((n) => n.kind === 'folder' && n.name === 'sub')).toBe(true)
    expect(srcChildren.some((n) => n.kind === 'file' && n.name === 'a.ts')).toBe(true)

    const sub = srcChildren.find((n) => n.kind === 'folder')!
    expect(snap.parentMap.get(sub.id)?.id).toBe(src.id)
    const subChildren = snap.childrenMap.get(sub.id) ?? []
    expect(subChildren).toHaveLength(1)
    expect((subChildren[0] as Extract<SearchNode, { kind: 'file' }>).name).toBe('b.ts')
  })

  it('tree mode without a root falls back to absolute path segments', () => {
    const results = [fileMatch('/ws/a.ts', [{ line: 1, ranges: 1 }])]
    const snap = buildSearchSnapshot(results, null, 'tree')
    // /ws/a.ts → ws (folder) → a.ts (file)
    expect(snap.roots[0]?.kind).toBe('folder')
    expect((snap.roots[0] as Extract<SearchNode, { kind: 'folder' }>).name).toBe('ws')
  })

  it('records every folder + file id as expandable', () => {
    const results = [fileMatch('/ws/src/a.ts', [{ line: 1, ranges: 1 }])]
    const snap = buildSearchSnapshot(results, root, 'tree')
    expect(snap.expandableIds).toContain('folder:src')
    expect(snap.expandableIds.some((id) => id.startsWith('file:'))).toBe(true)
  })

  it('orders files by path regardless of arrival order (ripgrep is nondeterministic)', () => {
    const paths = [
      '/ws/dir2/a.ts',
      '/ws/dir10/a.ts',
      '/ws/dir1/f10.ts',
      '/ws/dir1/f2.ts',
      '/ws/a.ts',
    ]
    const relOf = (nodes: SearchNode[]): string[] =>
      nodes
        .filter((n) => n.kind === 'file')
        .map((n) => (n as Extract<SearchNode, { kind: 'file' }>).relPath)

    // Two different arrival orders must produce the identical visible order.
    const forward = relOf(
      buildSearchSnapshot(
        paths.map((p) => fileMatch(p, [{ line: 1, ranges: 1 }])),
        root,
        'list',
      ).roots,
    )
    const reversed = relOf(
      buildSearchSnapshot(
        [...paths].reverse().map((p) => fileMatch(p, [{ line: 1, ranges: 1 }])),
        root,
        'list',
      ).roots,
    )
    expect(reversed).toEqual(forward)
    // Basename is numeric-aware (f2 before f10); directory segments use plain
    // string order like VSCode's comparePaths (dir10 before dir2). Root first.
    expect(forward).toEqual(['a.ts', 'dir1/f2.ts', 'dir1/f10.ts', 'dir10/a.ts', 'dir2/a.ts'])
  })
})
