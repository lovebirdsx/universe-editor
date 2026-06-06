/*---------------------------------------------------------------------------------------------
 *  Compact-folder tests for the SCM tree view. Mirrors the Explorer behaviour:
 *  a chain of directories that each hold a single subdirectory (and no files) is
 *  merged into one folder node whose label shows the joined path ("a/b/c").
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { IScmGroupModel } from '../../../services/extensions/ScmService.js'
import { buildSnapshot } from '../ScmView.js'

type FolderLike = { kind: 'folder'; id: string; name: string; path: string }

function group(
  id: string,
  handle: number,
  resources: Array<{ resourceUri: string; contextValue?: string }>,
): IScmGroupModel {
  return {
    id,
    handle,
    label: { get: () => id },
    hideWhenEmpty: { get: () => false },
    resources: { get: () => resources },
  } as unknown as IScmGroupModel
}

function folders(
  children: ReturnType<typeof buildSnapshot>['childrenMap'],
  id: string,
): FolderLike[] {
  return (children.get(id) ?? []).filter((n) => n.kind === 'folder') as unknown as FolderLike[]
}

const ROOT = 'D:/repo'

describe('ScmView — compact folders (tree mode)', () => {
  it('merges a single-subfolder chain into one folder node labelled "a/b/c"', () => {
    const snap = buildSnapshot(
      [group('changes', 1, [{ resourceUri: `${ROOT}/a/b/c/file.txt`, contextValue: 'M' }])],
      ROOT,
      'tree',
    )

    const top = folders(snap.childrenMap, 'group:changes')
    expect(top).toHaveLength(1)
    expect(top[0]!.name).toBe('a/b/c')
    // The node's path points at the leaf directory of the chain.
    expect(top[0]!.path).toBe('a/b/c')
    // The file hangs directly under the compact folder node.
    const files = (snap.childrenMap.get(top[0]!.id) ?? []).filter((n) => n.kind === 'file')
    expect(files).toHaveLength(1)
  })

  it('stops merging at a folder that also contains files', () => {
    const snap = buildSnapshot(
      [
        group('changes', 1, [
          { resourceUri: `${ROOT}/a/b/c/file.txt`, contextValue: 'M' },
          { resourceUri: `${ROOT}/a/x.txt`, contextValue: 'M' },
        ]),
      ],
      ROOT,
      'tree',
    )

    // `a` holds a file (x.txt) and a subfolder (b) → it must NOT be merged.
    const top = folders(snap.childrenMap, 'group:changes')
    expect(top.map((f) => f.name)).toEqual(['a'])
    // Below `a`, the `b/c` chain still compacts.
    const sub = folders(snap.childrenMap, top[0]!.id)
    expect(sub.map((f) => f.name)).toEqual(['b/c'])
  })

  it('stops merging at a folder with multiple subfolders', () => {
    const snap = buildSnapshot(
      [
        group('changes', 1, [
          { resourceUri: `${ROOT}/a/b/one.txt`, contextValue: 'M' },
          { resourceUri: `${ROOT}/a/d/two.txt`, contextValue: 'M' },
        ]),
      ],
      ROOT,
      'tree',
    )

    // `a` branches into `b` and `d` → not merged; the branches are leaf folders.
    const top = folders(snap.childrenMap, 'group:changes')
    expect(top.map((f) => f.name)).toEqual(['a'])
    const sub = folders(snap.childrenMap, top[0]!.id)
    expect(sub.map((f) => f.name).sort()).toEqual(['b', 'd'])
  })
})
