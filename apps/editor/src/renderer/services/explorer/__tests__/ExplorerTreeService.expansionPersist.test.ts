/*---------------------------------------------------------------------------------------------
 *  Explorer tree expansion persistence — the user's expanded-directory set is
 *  mirrored to WORKSPACE storage and restored on the next mount, across both a
 *  reload and a workspace switch. Regression coverage for the bug where opening
 *  a `workspace.focusEnabled` workspace reset the folding on every open: the
 *  tree only *looked* persisted before because ExplorerAutoRevealContribution
 *  re-expanded the active editor's ancestor chain, a chain focus filtering hides
 *  when the active file sits outside the focus set.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import { ExplorerTreeService } from '../ExplorerTreeService.js'
import { FakeFocusScopeService } from '../../focus/testing/fakeFocusScopeService.js'
import {
  FakeStorage,
  FakeWatcher,
  FakeWorkspaceService,
  flush,
  makeFs,
  makeInst,
} from './explorerTreeTestHarness.js'
import { _resetExplorerTreeStateForTests, storageKeyForRoot } from '../explorerTreeState.js'

const root = URI.file('/ws')
const a = URI.joinPath(root, 'a')
const ab = URI.joinPath(a, 'b')
const c = URI.joinPath(root, 'c')

function makeStandardFs() {
  return makeFs({
    [root.toString()]: [
      { name: 'a', isFile: false, isDirectory: true },
      { name: 'c', isFile: false, isDirectory: true },
      { name: 'README.md', isFile: true, isDirectory: false },
    ],
    [a.toString()]: [
      { name: 'b', isFile: false, isDirectory: true },
      { name: 'a.txt', isFile: true, isDirectory: false },
    ],
    [ab.toString()]: [{ name: 'ab.txt', isFile: true, isDirectory: false }],
    [c.toString()]: [{ name: 'c.txt', isFile: true, isDirectory: false }],
  })
}

/** Read the persisted expanded-id set for `root` straight from fake storage. */
function persistedIds(storage: FakeStorage, forRoot: URI): readonly string[] {
  const state = storage.store.get(storageKeyForRoot(forRoot)) as
    | { expandedIds?: readonly string[] }
    | undefined
  return state?.expandedIds ?? []
}

describe('ExplorerTreeService — expansion persistence', () => {
  let fs: ReturnType<typeof makeStandardFs>
  let ws: FakeWorkspaceService
  let watcher: FakeWatcher
  let storage: FakeStorage

  beforeEach(() => {
    _resetExplorerTreeStateForTests()
    fs = makeStandardFs()
    ws = new FakeWorkspaceService(root)
    watcher = new FakeWatcher()
    storage = new FakeStorage()
  })
  afterEach(() => {
    _resetExplorerTreeStateForTests()
  })

  function makeTree(focus?: FakeFocusScopeService): ExplorerTreeService {
    return makeInst(
      fs,
      ws,
      watcher,
      undefined,
      undefined,
      focus,
      undefined,
      storage,
    ).createInstance(ExplorerTreeService)
  }

  it('persists expanded directories (excluding the root) once the user expands', async () => {
    const tree = makeTree()
    await flush()
    await tree.expand(a)
    await tree.expand(ab)
    tree.flushExpansionState()

    const ids = persistedIds(storage, root)
    expect([...ids].sort()).toEqual([a.toString(), ab.toString()].sort())
    expect(ids).not.toContain(root.toString()) // the root always auto-expands — never stored
  })

  it('writes back the smaller set after a collapse', async () => {
    const tree = makeTree()
    await flush()
    await tree.expand(a)
    await tree.expand(ab)
    tree.collapse(a)
    tree.flushExpansionState()

    expect(persistedIds(storage, root)).toEqual([ab.toString()])
  })

  it('restores the persisted expansion on a fresh service instance (reload)', async () => {
    const tree1 = makeTree()
    await flush()
    await tree1.expand(a)
    await tree1.expand(ab)
    tree1.flushExpansionState()
    tree1.dispose()

    // A brand-new service over the same storage = a window reload.
    const tree2 = makeTree()
    await flush()

    expect(tree2.isExpanded(a)).toBe(true)
    expect(tree2.isExpanded(ab)).toBe(true)
    // Restoring re-pulled the children, so the rows are actually rendered.
    expect(tree2.getChildren(a)).not.toBeNull()
    expect(tree2.getChildren(ab)?.some((e) => e.name === 'ab.txt')).toBe(true)
  })

  it('restores nothing when nothing was persisted', async () => {
    const tree = makeTree()
    await flush()
    expect(tree.isExpanded(root)).toBe(true) // root always expands
    expect(tree.isExpanded(a)).toBe(false)
    expect(tree.isExpanded(ab)).toBe(false)
  })

  it('tolerates a persisted directory that no longer exists (and self-heals it out)', async () => {
    const gone = URI.joinPath(root, 'gone')
    const tree1 = makeTree()
    await flush()
    await tree1.expand(a)
    // Hand-seed a stale id the fs no longer has.
    tree1.flushExpansionState()
    tree1.dispose()
    storage.store.set(storageKeyForRoot(root), {
      expandedIds: [a.toString(), gone.toString()],
    })

    const tree2 = makeTree()
    await flush() // must not throw; the missing dir just fails to load

    expect(tree2.isExpanded(a)).toBe(true)
    // The stale id was filtered out of the model snapshot: the next persist
    // drops it. Trigger one and check.
    await tree2.expand(c)
    tree2.flushExpansionState()
    const ids = persistedIds(storage, root)
    expect(ids).toContain(a.toString())
    expect(ids).toContain(c.toString())
    expect(ids).not.toContain(gone.toString())
  })

  it('keeps restored expansion across a focus-folders change (focus hydration does not wipe it)', async () => {
    const focus = new FakeFocusScopeService(['a'], root)
    const tree = makeTree(focus)
    await flush()
    await tree.expand(a)
    tree.flushExpansionState()

    // The persisted set is read again on a fresh instance under the same focus.
    const tree2 = makeTree(focus)
    await flush()
    expect(tree2.isExpanded(a)).toBe(true)

    // Flipping focus must NOT collapse what was restored (focus re-reads
    // children but preserves expansion state).
    await focus.setFolders(['c'])
    await flush()
    expect(tree2.isExpanded(a)).toBe(true)
  })

  it('does not load directories outside the focus set during restore', async () => {
    // Persist an in-focus dir (a) and an out-of-focus dir (c) while focus is off.
    const tree1 = makeTree()
    await flush()
    await tree1.expand(a)
    await tree1.expand(c)
    tree1.flushExpansionState()
    tree1.dispose()

    // Restore under focus = [a]: c is out of scope and must not be listed.
    const focus = new FakeFocusScopeService(['a'], root)
    const listBefore = fs.calls.list.length
    const tree2 = makeTree(focus)
    await flush()

    expect(tree2.isExpanded(a)).toBe(true) // in-focus dir restored
    const newLists = fs.calls.list.slice(listBefore)
    expect(newLists).not.toContain(c.toString()) // no wasted load of out-of-focus dir
  })

  it('keeps per-root state isolated across a workspace switch', async () => {
    const other = URI.file('/other')
    fs.dirs.set(other.toString(), [{ name: 'x', isFile: false, isDirectory: true }])

    const tree = makeTree()
    await flush()
    await tree.expand(a)
    tree.flushExpansionState()

    // Switch to a workspace with its own (empty) persisted state.
    ws.setRoot(other)
    await flush()
    expect(tree.isExpanded(root)).toBe(false)
    expect(tree.isExpanded(other)).toBe(true) // new root auto-expands
    expect(tree.isExpanded(URI.joinPath(other, 'x'))).toBe(false)

    // Switching back restores the first root's expansion.
    ws.setRoot(root)
    await flush()
    expect(tree.isExpanded(a)).toBe(true)
    // …and the two roots' keys never bled into each other.
    expect(persistedIds(storage, root)).toEqual([a.toString()])
    expect(persistedIds(storage, other)).toEqual([])
  })

  it('does not clobber a directory the user collapsed after restore', async () => {
    const tree1 = makeTree()
    await flush()
    await tree1.expand(a)
    tree1.flushExpansionState()
    tree1.dispose()

    const tree2 = makeTree()
    await flush()
    expect(tree2.isExpanded(a)).toBe(true)

    // The user collapses it; a later re-restore (e.g. workspace-scope
    // rehydration) must not re-expand it against their will.
    tree2.collapse(a)
    tree2.flushExpansionState()
    storage.fireWorkspaceScopeChange()
    await flush()

    expect(tree2.isExpanded(a)).toBe(false)
  })
})
