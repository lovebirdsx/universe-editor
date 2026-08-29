/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/search/searchTree.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI, type IFileMatch } from '@universe-editor/platform'
import {
  buildSearchSnapshot,
  type SearchBuildContext,
  type SearchNode,
  type SearchSnapshot,
} from '../searchTree.js'
import type { SearchViewMode } from '../searchViewState.js'

function fileMatch(path: string, lines: { line: number; ranges: number }[]): IFileMatch {
  return {
    resource: URI.file(path),
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
    expect(fileA.dirPath).toBe('')
    expect(snap.childrenMap.get(fileA.id)).toHaveLength(2)

    const fileB = snap.roots[1] as Extract<SearchNode, { kind: 'file' }>
    expect(fileB.relPath).toBe('src/b.ts')
    expect(fileB.dirPath).toBe('src')
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

describe('buildSearchSnapshot incremental rebuilds', () => {
  const ctx = (
    snapshot: SearchSnapshot,
    mode: SearchViewMode,
    rootUri: URI | null = root,
  ): SearchBuildContext => ({ rootUri, mode, snapshot })

  /** Structural fingerprint — everything the tree renders from, order included. */
  const shapeOf = (snap: SearchSnapshot) => ({
    roots: snap.roots.map((n) => n.id),
    expandableIds: [...snap.expandableIds].sort(),
    children: [...snap.childrenMap.entries()]
      .map(([id, list]) => [id, list.map((n) => n.id)] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    parents: [...snap.parentMap.entries()]
      .map(([id, parent]) => [id, parent.id] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    nodeIds: [...snap.nodeById.keys()].sort(),
    files: snap.orderedFiles.map((fm) => fm.resource.toString()),
  })

  const fileNodeById = (snap: SearchSnapshot, path: string) =>
    snap.nodeById.get(`file:${URI.file(path).toString()}`)

  it('reuses file and match node objects for unchanged files', () => {
    const results = [
      fileMatch('/ws/a.ts', [{ line: 1, ranges: 2 }]),
      fileMatch('/ws/b.ts', [{ line: 3, ranges: 1 }]),
    ]
    const first = buildSearchSnapshot(results, root, 'list')
    const second = buildSearchSnapshot(results, root, 'list', ctx(first, 'list'))

    expect(second.roots[0]).toBe(first.roots[0])
    expect(second.roots[1]).toBe(first.roots[1])
    const fileId = first.roots[0]!.id
    expect(second.childrenMap.get(fileId)).toBe(first.childrenMap.get(fileId))
  })

  it('inserts a new file in sorted position while reusing the untouched ones', () => {
    const a = fileMatch('/ws/a.ts', [{ line: 1, ranges: 1 }])
    const c = fileMatch('/ws/c.ts', [{ line: 1, ranges: 1 }])
    const b = fileMatch('/ws/b.ts', [{ line: 1, ranges: 1 }])

    const first = buildSearchSnapshot([a, c], root, 'list')
    // Arrives last, must still land between a and c.
    const second = buildSearchSnapshot([a, c, b], root, 'list', ctx(first, 'list'))

    expect(second.roots.map((n) => (n as Extract<SearchNode, { kind: 'file' }>).name)).toEqual([
      'a.ts',
      'b.ts',
      'c.ts',
    ])
    expect(second.roots[0]).toBe(first.roots[0])
    expect(second.roots[2]).toBe(first.roots[1])
  })

  it('removes a file and cleans every map entry it owned', () => {
    const a = fileMatch('/ws/a.ts', [{ line: 1, ranges: 1 }])
    const b = fileMatch('/ws/b.ts', [{ line: 1, ranges: 2 }])

    const first = buildSearchSnapshot([a, b], root, 'list')
    const bFileId = `file:${b.resource.toString()}`
    const bMatchIds = (first.childrenMap.get(bFileId) ?? []).map((n) => n.id)
    expect(bMatchIds).toHaveLength(2)

    const second = buildSearchSnapshot([a], root, 'list', ctx(first, 'list'))

    expect(second.roots.map((n) => n.id)).toEqual([`file:${a.resource.toString()}`])
    expect(second.childrenMap.has(bFileId)).toBe(false)
    expect(second.nodeById.has(bFileId)).toBe(false)
    expect(second.expandableIds).not.toContain(bFileId)
    for (const id of bMatchIds) {
      expect(second.parentMap.has(id)).toBe(false)
      expect(second.nodeById.has(id)).toBe(false)
    }
  })

  it("rebuilds only the changed file's matches", () => {
    const a = fileMatch('/ws/a.ts', [{ line: 1, ranges: 2 }])
    const b = fileMatch('/ws/b.ts', [{ line: 1, ranges: 1 }])
    const first = buildSearchSnapshot([a, b], root, 'list')

    // Same URI, new object with more matches — the whole-file batch semantics.
    const aGrown = fileMatch('/ws/a.ts', [
      { line: 1, ranges: 2 },
      { line: 5, ranges: 1 },
    ])
    const second = buildSearchSnapshot([aGrown, b], root, 'list', ctx(first, 'list'))

    const aId = `file:${a.resource.toString()}`
    const bId = `file:${b.resource.toString()}`
    expect(second.childrenMap.get(aId)).toHaveLength(3)
    expect(second.childrenMap.get(aId)).not.toBe(first.childrenMap.get(aId))
    expect((second.nodeById.get(aId) as Extract<SearchNode, { kind: 'file' }>).matchCount).toBe(3)
    // The untouched file keeps its identity.
    expect(second.childrenMap.get(bId)).toBe(first.childrenMap.get(bId))
    expect(second.nodeById.get(bId)).toBe(first.nodeById.get(bId))
  })

  it('drops stale match entries when a file shrinks', () => {
    const a = fileMatch('/ws/a.ts', [{ line: 1, ranges: 3 }])
    const first = buildSearchSnapshot([a], root, 'list')
    const staleMatchId = first.childrenMap.get(`file:${a.resource.toString()}`)![2]!.id

    const aShrunk = fileMatch('/ws/a.ts', [{ line: 1, ranges: 1 }])
    const second = buildSearchSnapshot([aShrunk], root, 'list', ctx(first, 'list'))

    expect(second.nodeById.has(staleMatchId)).toBe(false)
    expect(second.parentMap.has(staleMatchId)).toBe(false)
  })

  it('falls back to a full rebuild when the view mode changes', () => {
    const results = [fileMatch('/ws/src/a.ts', [{ line: 1, ranges: 1 }])]
    const listSnap = buildSearchSnapshot(results, root, 'list')
    const treeSnap = buildSearchSnapshot(results, root, 'tree', ctx(listSnap, 'list'))

    expect(treeSnap.roots[0]?.kind).toBe('folder')
    expect(shapeOf(treeSnap)).toEqual(shapeOf(buildSearchSnapshot(results, root, 'tree')))
  })

  it('falls back to a full rebuild when the root changes', () => {
    const results = [fileMatch('/ws/src/a.ts', [{ line: 1, ranges: 1 }])]
    const first = buildSearchSnapshot(results, root, 'list')
    const other = URI.file('/ws/src')
    const second = buildSearchSnapshot(results, other, 'list', ctx(first, 'list'))

    expect((second.roots[0] as Extract<SearchNode, { kind: 'file' }>).relPath).toBe('a.ts')
    expect(shapeOf(second)).toEqual(shapeOf(buildSearchSnapshot(results, other, 'list')))
  })

  for (const mode of ['list', 'tree'] as const) {
    it(`${mode} mode: streamed incremental result matches a from-scratch build`, () => {
      // Files arrive out of order across batches, some revised in a later batch —
      // exactly what the main process does while a search streams.
      const initial = [
        fileMatch('/ws/src/z.ts', [{ line: 1, ranges: 1 }]),
        fileMatch('/ws/a.ts', [{ line: 2, ranges: 2 }]),
      ]
      const batch2 = [
        fileMatch('/ws/src/deep/m.ts', [{ line: 1, ranges: 1 }]),
        fileMatch('/ws/b.ts', [{ line: 4, ranges: 3 }]),
      ]
      const revisedA = fileMatch('/ws/a.ts', [
        { line: 2, ranges: 2 },
        { line: 9, ranges: 1 },
      ])
      const batch3 = [fileMatch('/ws/src/aa.ts', [{ line: 1, ranges: 1 }]), revisedA]

      // Accumulate the way useSearchEngine does: a Map keyed by URI string.
      const accum = new Map<string, IFileMatch>()
      let snap = buildSearchSnapshot([], root, mode)
      let previous: SearchBuildContext = ctx(snap, mode)
      for (const batch of [initial, batch2, batch3]) {
        for (const fm of batch) accum.set(fm.resource.toString(), fm)
        snap = buildSearchSnapshot([...accum.values()], root, mode, previous)
        previous = ctx(snap, mode)
      }

      const fromScratch = buildSearchSnapshot([...accum.values()], root, mode)
      expect(shapeOf(snap)).toEqual(shapeOf(fromScratch))
    })
  }

  it('tree mode: reuses unchanged match nodes while rebuilding the folder layer', () => {
    const a = fileMatch('/ws/src/a.ts', [{ line: 1, ranges: 2 }])
    const first = buildSearchSnapshot([a], root, 'tree')
    const aId = `file:${a.resource.toString()}`
    const aMatches = first.childrenMap.get(aId)

    const b = fileMatch('/ws/lib/b.ts', [{ line: 1, ranges: 1 }])
    const second = buildSearchSnapshot([a, b], root, 'tree', ctx(first, 'tree'))

    expect(second.childrenMap.get(aId)).toBe(aMatches)
    expect(second.nodeById.get(aId)).toBe(first.nodeById.get(aId))
    // Folder nodes are rebuilt, never reused.
    const folders = second.roots.filter((n) => n.kind === 'folder')
    expect(folders.map((n) => (n as Extract<SearchNode, { kind: 'folder' }>).name).sort()).toEqual([
      'lib',
      'src',
    ])
    expect(second.roots.find((n) => n.id === 'folder:src')).not.toBe(
      first.roots.find((n) => n.id === 'folder:src'),
    )
  })

  it('tree mode: compacted folder chains do not accumulate across rebuilds', () => {
    // Single-child chain a/b — compactChains renames the node in place, so a
    // reused folder node would grow to "a/b/b" on the second pass.
    const c = fileMatch('/ws/a/b/c.ts', [{ line: 1, ranges: 1 }])
    const first = buildSearchSnapshot([c], root, 'tree')
    expect((first.roots[0] as Extract<SearchNode, { kind: 'folder' }>).name).toBe('a/b')

    let snap = first
    for (let i = 0; i < 3; i++) {
      snap = buildSearchSnapshot([c], root, 'tree', ctx(snap, 'tree'))
      expect((snap.roots[0] as Extract<SearchNode, { kind: 'folder' }>).name).toBe('a/b')
    }
    expect(shapeOf(snap)).toEqual(shapeOf(buildSearchSnapshot([c], root, 'tree')))
  })

  it('tree mode: a 3-level chain leaves no orphan folder nodes behind', () => {
    // A 2-level chain compacts in a single lap, so it cannot catch a stale
    // bookkeeping key. Three levels make the loop run twice, and the second lap
    // sees a node whose relPath the first lap already rewrote.
    const d = fileMatch('/ws/a/b/c/d.ts', [{ line: 1, ranges: 1 }])
    const snapshot = buildSearchSnapshot([d], root, 'tree')
    expect((snapshot.roots[0] as Extract<SearchNode, { kind: 'folder' }>).name).toBe('a/b/c')

    // Every id reachable from the tree, versus every id the snapshot indexes.
    const reachable = new Set<string>()
    const walk = (nodes: readonly SearchNode[]): void => {
      for (const node of nodes) {
        reachable.add(node.id)
        walk(snapshot.childrenMap.get(node.id) ?? [])
      }
    }
    walk(snapshot.roots)
    expect([...snapshot.nodeById.keys()].filter((id) => !reachable.has(id))).toEqual([])
    expect(shapeOf(snapshot)).toEqual(shapeOf(buildSearchSnapshot([d], root, 'tree')))
  })

  it('tree mode: folder match counts follow the revised file', () => {
    const a = fileMatch('/ws/src/a.ts', [{ line: 1, ranges: 1 }])
    const first = buildSearchSnapshot([a], root, 'tree')
    expect(fileNodeById(first, '/ws/src/a.ts')).toBeDefined()
    expect((first.roots[0] as Extract<SearchNode, { kind: 'folder' }>).matchCount).toBe(1)

    const aGrown = fileMatch('/ws/src/a.ts', [{ line: 1, ranges: 4 }])
    const second = buildSearchSnapshot([aGrown], root, 'tree', ctx(first, 'tree'))
    expect((second.roots[0] as Extract<SearchNode, { kind: 'folder' }>).matchCount).toBe(4)
  })

  it('an emptied result set clears the snapshot', () => {
    const a = fileMatch('/ws/a.ts', [{ line: 1, ranges: 1 }])
    const first = buildSearchSnapshot([a], root, 'list')
    const second = buildSearchSnapshot([], root, 'list', ctx(first, 'list'))

    expect(second.roots).toHaveLength(0)
    expect(second.nodeById.size).toBe(0)
    expect(second.childrenMap.size).toBe(0)
    expect(second.parentMap.size).toBe(0)
    expect(second.expandableIds).toHaveLength(0)
  })
})
