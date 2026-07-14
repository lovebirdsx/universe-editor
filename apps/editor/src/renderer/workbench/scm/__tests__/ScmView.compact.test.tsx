/*---------------------------------------------------------------------------------------------
 *  Compact-folder tests for the SCM tree view. Mirrors the Explorer behaviour:
 *  a chain of directories that each hold a single subdirectory (and no files) is
 *  merged into one folder node whose label shows the joined path ("a/b/c").
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { IScmGroupModel } from '../../../services/extensions/ScmService.js'
import { buildSnapshot, groupIconName } from '../ScmView.js'

type FolderLike = { kind: 'folder'; id: string; name: string; path: string }

function group(
  id: string,
  handle: number,
  resources: Array<{ resourceUri: string; contextValue?: string }>,
  parentId?: string,
): IScmGroupModel {
  return {
    id,
    handle,
    parentId,
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

describe('ScmView — nested groups (parentId)', () => {
  it('nests a child group under its parent group node instead of at top level', () => {
    const snap = buildSnapshot(
      [
        group('cl:5', 1, [{ resourceUri: `${ROOT}/a.txt`, contextValue: 'E' }]),
        group('shelved:5', 2, [{ resourceUri: '//depot/a.txt', contextValue: 'S' }], 'cl:5'),
      ],
      ROOT,
      'list',
    )

    // Only the parent changelist is a top-level group; the shelved group is nested.
    const topGroups = snap.roots.filter((n) => n.kind === 'group')
    expect(topGroups.map((n) => n.id)).toEqual(['group:cl:5'])

    // The shelved group node hangs under the changelist group, after its files.
    const clChildren = snap.childrenMap.get('group:cl:5') ?? []
    const nestedGroup = clChildren.find((n) => n.kind === 'group')
    expect(nestedGroup?.id).toBe('group:shelved:5')
    // Its parent is recorded so keyboard navigation / reveal works.
    expect(snap.parentMap.get('group:shelved:5')?.id).toBe('group:cl:5')
    // The shelved file hangs under the nested group.
    const shelvedFiles = (snap.childrenMap.get('group:shelved:5') ?? []).filter(
      (n) => n.kind === 'file',
    )
    expect(shelvedFiles).toHaveLength(1)
  })

  it('falls back to top level when the parent group is absent', () => {
    const snap = buildSnapshot(
      [group('shelved:9', 1, [{ resourceUri: '//depot/x.txt', contextValue: 'S' }], 'cl:9')],
      ROOT,
      'list',
    )
    expect(snap.roots.filter((n) => n.kind === 'group').map((n) => n.id)).toEqual([
      'group:shelved:9',
    ])
  })
})

describe('groupIconName', () => {
  it('gives the default and numbered changelists the same (changelist) glyph', () => {
    // The whole point of the icon: sibling changelists read as one category, so
    // the default group no longer looks unlike a numbered one.
    expect(groupIconName('default')).toBe('changelist')
    expect(groupIconName('cl:8084918')).toBe('changelist')
  })

  it('distinguishes reconcile and shelved groups', () => {
    expect(groupIconName('reconcile')).toBe('reconcile')
    expect(groupIconName('shelved:5')).toBe('archive')
  })

  it('returns undefined for unrecognized group ids (no icon rendered)', () => {
    expect(groupIconName('workingTree')).toBeUndefined()
    expect(groupIconName('index')).toBeUndefined()
  })
})
