/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/explorer/ExplorerTreeService.ts
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest'
import {
  InstantiationService,
  URI,
  type IDirectoryEntry,
  type UriComponents,
} from '@universe-editor/platform'
import { ExplorerTreeService } from '../ExplorerTreeService.js'
import { incrementFileName } from '../explorerFileOperations.js'
import { IExcludeService } from '../../exclude/ExcludeService.js'
import { FakeExcludeService } from '../../exclude/testing/fakeExcludeService.js'
import { FakeFocusScopeService } from '../../focus/testing/fakeFocusScopeService.js'
import {
  FakeWatcher,
  FakeWorkspaceService,
  flush,
  makeFileClipboard,
  makeFs,
  makeInst,
  makeLogger,
  type FakeFs,
} from './explorerTreeTestHarness.js'

const root = URI.file('/ws')

describe('ExplorerTreeService', () => {
  let fs: FakeFs
  let ws: FakeWorkspaceService
  let watcher: FakeWatcher
  let inst: InstantiationService

  beforeEach(() => {
    fs = makeFs({
      [root.toString()]: [
        { name: 'src', isFile: false, isDirectory: true },
        { name: 'README.md', isFile: true, isDirectory: false },
      ],
      [URI.joinPath(root, 'src').toString()]: [
        { name: 'index.ts', isFile: true, isDirectory: false },
      ],
    })
    ws = new FakeWorkspaceService(root)
    watcher = new FakeWatcher()
    inst = makeInst(fs, ws, watcher)
  })

  it('seeds root expansion and lists children on construction', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    expect(tree.root?.toString()).toBe(root.toString())
    expect(tree.isExpanded(root)).toBe(true)
    expect(tree.getChildren(root)).toHaveLength(2)
    // directories before files
    expect(tree.getChildren(root)?.[0]?.name).toBe('src')
  })

  it('expand calls fs.list once and caches children', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const src = URI.joinPath(root, 'src')
    await tree.expand(src)
    await tree.expand(src)
    expect(fs.calls.list.filter((p) => p === src.toString())).toHaveLength(1)
    expect(tree.getChildren(src)).toHaveLength(1)
  })

  it('collapse flips expanded flag without re-fetching', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const src = URI.joinPath(root, 'src')
    await tree.expand(src)
    tree.collapse(src)
    expect(tree.isExpanded(src)).toBe(false)
    await tree.expand(src)
    expect(fs.calls.list.filter((p) => p === src.toString())).toHaveLength(1)
  })

  it('createFile writes through fs and refreshes the parent', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    fs.dirs.set(root.toString(), [
      ...(fs.dirs.get(root.toString()) ?? []),
      { name: 'a.txt', isFile: true, isDirectory: false },
    ])
    const created = await tree.createFile(root, 'a.txt')
    expect(created.toString()).toBe(URI.joinPath(root, 'a.txt').toString())
    expect(fs.calls.writeFile).toContain(created.toString())
    expect(tree.getChildren(root)?.some((c) => c.name === 'a.txt')).toBe(true)
  })

  it('createFile rejects when target already exists', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    fs.files.add(URI.joinPath(root, 'dup.txt').toString())
    await expect(tree.createFile(root, 'dup.txt')).rejects.toThrow(/already exists/)
    expect(fs.calls.writeFile).not.toContain(URI.joinPath(root, 'dup.txt').toString())
  })

  it('createFolder makes the directory and refreshes the parent', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    fs.dirs.set(root.toString(), [
      ...(fs.dirs.get(root.toString()) ?? []),
      { name: 'new', isFile: false, isDirectory: true },
    ])
    const created = await tree.createFolder(root, 'new')
    expect(fs.calls.createDirectory).toContain(created.toString())
  })

  it('rename moves the resource and refreshes the parent', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    fs.files.add(URI.joinPath(root, 'README.md').toString())
    const target = await tree.rename(URI.joinPath(root, 'README.md'), 'README2.md')
    expect(target.toString()).toBe(URI.joinPath(root, 'README2.md').toString())
    expect(fs.calls.rename[0]).toContain('README.md→')
  })

  it('delete removes from fs and refreshes the parent', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    fs.files.add(URI.joinPath(root, 'README.md').toString())
    await tree.delete(URI.joinPath(root, 'README.md'))
    expect(fs.calls.delete).toContain(URI.joinPath(root, 'README.md').toString())
  })

  it('tracks and clears Explorer clipboard cut state', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const readme = URI.joinPath(root, 'README.md')
    tree.adoptClipboard([{ resource: readme, isDirectory: false }], true)
    expect(tree.hasClipboard).toBe(true)
    expect(tree.clipboardIsCut).toBe(true)
    expect(tree.isCut(readme)).toBe(true)

    tree.clearClipboard()
    expect(tree.hasClipboard).toBe(false)
    expect(tree.isCut(readme)).toBe(false)
  })

  it('adoptClipboard writes local state only and never calls the shared service', async () => {
    const fileClipboard = makeFileClipboard()
    const tree = makeInst(fs, ws, watcher, undefined, fileClipboard).createInstance(
      ExplorerTreeService,
    )
    await flush()
    const readme = URI.joinPath(root, 'README.md')
    tree.adoptClipboard([{ resource: readme, isDirectory: false }], true)
    expect(tree.hasClipboard).toBe(true)
    expect(tree.clipboardIsCut).toBe(true)
    expect(fileClipboard.writeResources).not.toHaveBeenCalled()
    expect(fileClipboard.clear).not.toHaveBeenCalled()
  })

  it('clearClipboard also clears the shared clipboard', async () => {
    const fileClipboard = makeFileClipboard()
    const tree = makeInst(fs, ws, watcher, undefined, fileClipboard).createInstance(
      ExplorerTreeService,
    )
    await flush()
    tree.adoptClipboard([{ resource: URI.joinPath(root, 'README.md'), isDirectory: false }], true)
    tree.clearClipboard()
    expect(fileClipboard.clear).toHaveBeenCalledTimes(1)
  })

  it('clearClipboard with an empty clipboard leaves the shared service untouched', async () => {
    const fileClipboard = makeFileClipboard()
    const tree = makeInst(fs, ws, watcher, undefined, fileClipboard).createInstance(
      ExplorerTreeService,
    )
    await flush()
    tree.clearClipboard()
    expect(fileClipboard.clear).not.toHaveBeenCalled()
  })

  it('switching the workspace root never touches the shared clipboard', async () => {
    const fileClipboard = makeFileClipboard()
    const tree = makeInst(fs, ws, watcher, undefined, fileClipboard).createInstance(
      ExplorerTreeService,
    )
    await flush()
    tree.adoptClipboard([{ resource: URI.joinPath(root, 'README.md'), isDirectory: false }], true)
    const other = URI.file('/other')
    fs.dirs.set(other.toString(), [])
    ws.setRoot(other)
    await flush()
    // The shared clipboard is global (all windows, plus the OS clipboard);
    // another window switching folders must not destroy a pending cut.
    expect(fileClipboard.clear).not.toHaveBeenCalled()
    expect(tree.hasClipboard).toBe(true)
  })

  it('increments duplicate file names like VSCode simple naming', () => {
    expect(incrementFileName('README.md', false)).toBe('README copy.md')
    expect(incrementFileName('README copy.md', false)).toBe('README copy 2.md')
    expect(incrementFileName('README copy 2.md', false)).toBe('README copy 3.md')
    expect(incrementFileName('src', true)).toBe('src copy')
  })

  it('finds the next available duplicate name in the same folder', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const readme = URI.joinPath(root, 'README.md')
    fs.files.add(readme.toString())
    fs.files.add(URI.joinPath(root, 'README copy.md').toString())
    await expect(tree.defaultDuplicateName({ resource: readme, isDirectory: false })).resolves.toBe(
      'README copy 2.md',
    )
  })

  it('duplicate copies to the prompted sibling name', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const readme = URI.joinPath(root, 'README.md')
    const target = URI.joinPath(root, 'README copy.md')
    fs.files.add(readme.toString())
    await tree.duplicate({ resource: readme, isDirectory: false }, 'README copy.md')

    expect(fs.calls.copy).toContain(`${readme.toString()}→${target.toString()}`)
    expect(fs.files.has(target.toString())).toBe(true)
  })

  it('copyResources avoids same-folder collisions with incremental names', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const readme = URI.joinPath(root, 'README.md')
    const existing = URI.joinPath(root, 'README copy.md')
    const target = URI.joinPath(root, 'README copy 2.md')
    fs.files.add(readme.toString())
    fs.files.add(existing.toString())

    const copied = await tree.copyResources([{ resource: readme, isDirectory: false }], root)

    expect(copied.map((uri) => uri.toString())).toEqual([target.toString()])
    expect(fs.files.has(target.toString())).toBe(true)
  })

  it('moveResources renames into the destination folder', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const readme = URI.joinPath(root, 'README.md')
    const src = URI.joinPath(root, 'src')
    const target = URI.joinPath(src, 'README.md')
    fs.files.add(readme.toString())

    const moved = await tree.moveResources([{ resource: readme, isDirectory: false }], src)

    expect(moved.map((uri) => uri.toString())).toEqual([target.toString()])
    expect(fs.files.has(readme.toString())).toBe(false)
    expect(fs.files.has(target.toString())).toBe(true)
  })

  it('moveResources clears cut state for moved resources', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const readme = URI.joinPath(root, 'README.md')
    const src = URI.joinPath(root, 'src')
    fs.files.add(readme.toString())
    tree.adoptClipboard([{ resource: readme, isDirectory: false }], true)

    await tree.moveResources([{ resource: readme, isDirectory: false }], src)

    expect(tree.hasClipboard).toBe(false)
    expect(tree.isCut(readme)).toBe(false)
  })

  it('rejects placing a folder inside itself or a descendant', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const src = URI.joinPath(root, 'src')
    const nested = URI.joinPath(src, 'nested')
    fs.dirs.set(nested.toString(), [])

    await expect(
      tree.moveResources([{ resource: src, isDirectory: true }], nested),
    ).rejects.toThrow(/inside itself/)
  })

  it('switching workspace folders drops the prior root', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const other = URI.file('/other')
    fs.dirs.set(other.toString(), [])
    ws.setRoot(other)
    await flush()
    expect(tree.root?.toString()).toBe(other.toString())
    expect(tree.isExpanded(root)).toBe(false)
  })

  it('fs.list errors surface on the node without crashing', async () => {
    const logger = makeLogger()
    const tree = makeInst(fs, ws, watcher, logger).createInstance(ExplorerTreeService)
    await flush()
    const bad = URI.joinPath(root, 'missing')
    fs.dirs.delete(bad.toString())
    // Override list to throw
    const origList = fs.list.bind(fs)
    fs.list = async (uri: URI) => {
      if (uri.toString() === bad.toString()) throw new Error('boom')
      return origList(uri)
    }
    await tree.expand(bad)
    expect(tree.getChildren(bad)).toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(`loadChildren failed ${bad.toString()}`, 'boom')
  })

  it('fires onDidChange when state mutates', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    let count = 0
    tree.onDidChange(() => count++)
    const src = URI.joinPath(root, 'src')
    await tree.expand(src)
    expect(count).toBeGreaterThan(0)
  })

  it('watcher event with a known parent triggers refresh', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    fs.calls.list.length = 0
    fs.dirs.set(root.toString(), [
      ...(fs.dirs.get(root.toString()) ?? []),
      { name: 'new.txt', isFile: true, isDirectory: false },
    ])
    watcher.fire([{ type: 'modified', resource: URI.joinPath(root, 'new.txt') }])
    await flush()
    expect(fs.calls.list).toContain(root.toString())
    expect(tree.getChildren(root)?.some((c) => c.name === 'new.txt')).toBe(true)
  })

  it('watcher event for an unknown parent is ignored', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    fs.calls.list.length = 0
    const stranger = URI.file('/elsewhere/x.txt')
    watcher.fire([{ type: 'modified', resource: stranger }])
    await flush()
    expect(fs.calls.list).toHaveLength(0)
    expect(tree).toBeDefined()
  })

  it('switching workspace re-arms the watcher on the new root', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    // Cold start defers the watch to WorkspaceWatchContribution (Eventually
    // phase); simulate it explicitly rather than relying on idle timing.
    tree.startWatching()
    expect(watcher.watched.map((u) => URI.revive(u)?.toString())).toContain(root.toString())
    const other = URI.file('/other')
    fs.dirs.set(other.toString(), [])
    ws.setRoot(other)
    await flush()
    expect(watcher.watched.map((u) => URI.revive(u)?.toString())).toContain(other.toString())
  })

  it('re-reads the root once the watch ack resolves, catching files created before the subscription went live', async () => {
    // Simulate the real watcher latency: watch() acks only after the utility
    // process armed the subscription. A file written during that window fires
    // no event, so the tree must re-read on ack or it never appears.
    let resolveWatch!: () => void
    watcher.watch = (folder: UriComponents) => {
      watcher.watched.push(folder)
      return new Promise<void>((r) => {
        resolveWatch = r
      })
    }
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    tree.startWatching()
    expect(watcher.watched.map((u) => URI.revive(u)?.toString())).toContain(root.toString())

    // External creation inside the request→ack window: no watcher event.
    fs.dirs.set(root.toString(), [
      ...(fs.dirs.get(root.toString()) ?? []),
      { name: 'early.txt', isFile: true, isDirectory: false },
    ])
    fs.calls.list.length = 0
    resolveWatch()
    await flush()
    expect(fs.calls.list).toContain(root.toString())
    expect(tree.getChildren(root)?.some((c) => c.name === 'early.txt')).toBe(true)
  })

  it('reveal on a direct child of the root selects it', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const target = URI.joinPath(root, 'README.md')
    const ok = await tree.reveal(target)
    expect(ok).toBe(true)
    expect(tree.selectedResource?.toString()).toBe(target.toString())
    expect(tree.isExpanded(root)).toBe(true)
  })

  it('reveal expands every ancestor before selecting', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const src = URI.joinPath(root, 'src')
    expect(tree.isExpanded(src)).toBe(false)
    const target = URI.joinPath(src, 'index.ts')
    const ok = await tree.reveal(target)
    expect(ok).toBe(true)
    expect(tree.isExpanded(src)).toBe(true)
    expect(tree.selectedResource?.toString()).toBe(target.toString())
  })

  it('reveal returns false for a target outside the workspace', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const ok = await tree.reveal(URI.file('/elsewhere/x.txt'))
    expect(ok).toBe(false)
    expect(tree.selectedResource).toBeNull()
  })

  it('setSelection updates selectedResource and fires onDidChange', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    let fired = 0
    tree.onDidChange(() => fired++)
    const target = URI.joinPath(root, 'README.md')
    tree.setSelection(target)
    expect(tree.selectedResource?.toString()).toBe(target.toString())
    expect(fired).toBeGreaterThan(0)
    fired = 0
    tree.setSelection(target)
    expect(fired).toBe(0)
  })

  it('setSelection with an array stores every entry and sets focus to the last by default', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const a = URI.joinPath(root, 'README.md')
    const b = URI.joinPath(root, 'src')
    tree.setSelection([a, b])
    expect(tree.selection.map((u) => u.toString())).toEqual([a.toString(), b.toString()])
    expect(tree.focused?.toString()).toBe(b.toString())
  })

  it('setSelection honors an explicit focus argument', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const a = URI.joinPath(root, 'README.md')
    const b = URI.joinPath(root, 'src')
    tree.setSelection([a, b], a)
    expect(tree.focused?.toString()).toBe(a.toString())
  })

  it('setFocus updates focus alone, leaving the selection untouched', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const a = URI.joinPath(root, 'README.md')
    const b = URI.joinPath(root, 'src')
    tree.setSelection([a], a)
    tree.setFocus(b)
    expect(tree.focused?.toString()).toBe(b.toString())
    expect(tree.selection.map((u) => u.toString())).toEqual([a.toString()])
  })

  it('toggleInSelection adds when absent and removes when present', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const a = URI.joinPath(root, 'README.md')
    const b = URI.joinPath(root, 'src')
    tree.setSelection([a], a)
    tree.toggleInSelection(b)
    expect(tree.selection.map((u) => u.toString()).sort()).toEqual(
      [a.toString(), b.toString()].sort(),
    )
    expect(tree.focused?.toString()).toBe(b.toString())
    tree.toggleInSelection(b)
    expect(tree.selection.map((u) => u.toString())).toEqual([a.toString()])
    expect(tree.focused?.toString()).toBe(b.toString())
  })

  it('extendSelectionTo spans the inclusive range from the current focus', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(URI.joinPath(root, 'src'))
    const visible = tree.getVisibleEntries()
    // [root, src, index.ts, README.md]
    const anchor = visible[1]!.resource // src
    const target = visible[3]!.resource // README.md
    tree.setSelection([anchor], anchor)
    tree.extendSelectionTo(target)
    expect(tree.selection.map((u) => u.toString())).toEqual([
      visible[1]!.resource.toString(),
      visible[2]!.resource.toString(),
      visible[3]!.resource.toString(),
    ])
    expect(tree.focused?.toString()).toBe(target.toString())
  })

  it('extendSelectionTo works in reverse order too', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(URI.joinPath(root, 'src'))
    const visible = tree.getVisibleEntries()
    const anchor = visible[3]!.resource
    const target = visible[1]!.resource
    tree.setSelection([anchor], anchor)
    tree.extendSelectionTo(target)
    expect(tree.selection.map((u) => u.toString())).toEqual([
      visible[1]!.resource.toString(),
      visible[2]!.resource.toString(),
      visible[3]!.resource.toString(),
    ])
    expect(tree.focused?.toString()).toBe(target.toString())
  })

  it('extendSelectionTo keeps the first anchor across repeated calls', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(URI.joinPath(root, 'src'))
    const visible = tree.getVisibleEntries()
    tree.setSelection([visible[0]!.resource], visible[0]!.resource)
    tree.extendSelectionTo(visible[1]!.resource)
    tree.extendSelectionTo(visible[2]!.resource)
    expect(tree.selection.map((u) => u.toString())).toEqual(
      visible.slice(0, 3).map((v) => v.resource.toString()),
    )
    expect(tree.focused?.toString()).toBe(visible[2]!.resource.toString())
  })

  it('setActiveEditorResource fires onDidChange and exposes the value', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    let fired = 0
    tree.onDidChange(() => fired++)
    const target = URI.joinPath(root, 'README.md')
    tree.setActiveEditorResource(target)
    expect(tree.activeEditorResource?.toString()).toBe(target.toString())
    expect(fired).toBeGreaterThan(0)
    fired = 0
    tree.setActiveEditorResource(target)
    expect(fired).toBe(0)
  })

  it('reveal sets focus and replaces the selection with the single target', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const a = URI.joinPath(root, 'README.md')
    const b = URI.joinPath(URI.joinPath(root, 'src'), 'index.ts')
    tree.setSelection([a, URI.joinPath(root, 'src')])
    await tree.reveal(b)
    expect(tree.focused?.toString()).toBe(b.toString())
    expect(tree.selection.map((u) => u.toString())).toEqual([b.toString()])
  })

  it('switching workspace folders resets every selection-related state', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    tree.setSelection([URI.joinPath(root, 'README.md')])
    tree.setActiveEditorResource(URI.joinPath(root, 'README.md'))
    const other = URI.file('/other')
    fs.dirs.set(other.toString(), [])
    ws.setRoot(other)
    await flush()
    expect(tree.selection).toEqual([])
    expect(tree.focused).toBeNull()
    expect(tree.activeEditorResource).toBeNull()
  })
})

describe('ExplorerTreeService — Windows drive letter case mismatch', () => {
  // Use URI paths with Windows-style drive letters to simulate case mismatch
  const winRoot = URI.from({ scheme: 'file', path: '/C:/ws' })
  const winRootLower = URI.from({ scheme: 'file', path: '/c:/ws' })

  function makeWinFs() {
    return makeFs({
      [winRoot.toString()]: [
        { name: 'src', isFile: false, isDirectory: true },
        { name: 'README.md', isFile: true, isDirectory: false },
      ],
      [URI.joinPath(winRoot, 'src').toString()]: [
        { name: 'index.ts', isFile: true, isDirectory: false },
      ],
    })
  }

  function makeWinInst(fs: ReturnType<typeof makeFs>) {
    const ws = new FakeWorkspaceService(winRoot)
    const watcher = new FakeWatcher()
    return makeInst(fs, ws, watcher)
  }

  it('reveal succeeds when target path has different drive letter case than root', async () => {
    const inst = makeWinInst(makeWinFs())
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()

    // Tree root was set with uppercase C:, reveal with lowercase c:
    const target = URI.from({ scheme: 'file', path: '/c:/ws/README.md' })
    const ok = await tree.reveal(target)
    expect(ok).toBe(true)
    expect(tree.selectedResource).not.toBeNull()
  })

  it('reveal expands ancestors when target drive letter case differs from root', async () => {
    const inst = makeWinInst(makeWinFs())
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()

    const target = URI.from({ scheme: 'file', path: '/c:/ws/src/index.ts' })
    const ok = await tree.reveal(target)
    expect(ok).toBe(true)
    const srcLower = URI.from({ scheme: 'file', path: '/c:/ws/src' })
    const srcUpper = URI.from({ scheme: 'file', path: '/C:/ws/src' })
    expect(tree.isExpanded(srcLower) || tree.isExpanded(srcUpper)).toBe(true)
  })

  it('setActiveEditorResource deduplicates URIs that differ only in drive letter case', async () => {
    const inst = makeWinInst(makeWinFs())
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()

    tree.setActiveEditorResource(winRoot)
    let fired = 0
    tree.onDidChange(() => fired++)

    // Same path, different drive letter case — should be treated as identical
    tree.setActiveEditorResource(winRootLower)
    expect(fired).toBe(0)
  })
})

describe('ExplorerTreeService — compact folders', () => {
  const root = URI.file('/compact')
  const src = URI.joinPath(root, 'src')
  const lib = URI.joinPath(src, 'lib')
  const utils = URI.joinPath(lib, 'utils')

  function makeCompactFs() {
    return makeFs({
      [root.toString()]: [{ name: 'src', isFile: false, isDirectory: true }],
      [src.toString()]: [{ name: 'lib', isFile: false, isDirectory: true }],
      [lib.toString()]: [],
    })
  }

  function makeDeepCompactFs() {
    return makeFs({
      [root.toString()]: [{ name: 'src', isFile: false, isDirectory: true }],
      [src.toString()]: [{ name: 'lib', isFile: false, isDirectory: true }],
      [lib.toString()]: [{ name: 'utils', isFile: false, isDirectory: true }],
      [utils.toString()]: [],
    })
  }

  function flush(): Promise<void> {
    return new Promise((r) => setTimeout(r, 0))
  }

  it('compact entry has compactName showing the merged path', async () => {
    const inst = makeInst(makeCompactFs(), new FakeWorkspaceService(root), new FakeWatcher())
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const visible = tree.getVisibleEntries()
    const compact = visible.find((e) => e.compactName !== undefined)
    expect(compact).toBeDefined()
    expect(compact?.compactName).toBe('src/lib')
    expect(compact?.resource.toString()).toBe(lib.toString())
  })

  it('compact entry exposes compactRoot pointing to the chain head (src)', async () => {
    const inst = makeInst(makeCompactFs(), new FakeWorkspaceService(root), new FakeWatcher())
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const visible = tree.getVisibleEntries()
    const compact = visible.find((e) => e.compactName !== undefined)
    // compactRoot must be src — the topmost dir in the compact chain
    expect(compact?.compactRoot?.toString()).toBe(src.toString())
  })

  it('deep compact entry exposes compactRoot pointing to src (chain head)', async () => {
    const inst = makeInst(makeDeepCompactFs(), new FakeWorkspaceService(root), new FakeWatcher())
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const visible = tree.getVisibleEntries()
    const compact = visible.find((e) => e.compactName !== undefined)
    expect(compact?.compactName).toBe('src/lib/utils')
    expect(compact?.compactRoot?.toString()).toBe(src.toString())
  })

  it('non-compact entries have no compactRoot', async () => {
    const fs = makeFs({
      [root.toString()]: [
        { name: 'src', isFile: false, isDirectory: true },
        { name: 'README.md', isFile: true, isDirectory: false },
      ],
      [src.toString()]: [
        { name: 'a', isFile: false, isDirectory: true },
        { name: 'b', isFile: false, isDirectory: true },
      ],
    })
    const inst = makeInst(fs, new FakeWorkspaceService(root), new FakeWatcher())
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    const visible = tree.getVisibleEntries()
    for (const e of visible) {
      expect(e.compactRoot).toBeUndefined()
      expect(e.compactName).toBeUndefined()
    }
  })

  it('file created in compact leaf is visible as a child of the compact node', async () => {
    const fs = makeCompactFs()
    const inst = makeInst(fs, new FakeWorkspaceService(root), new FakeWatcher())
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(lib)
    expect(tree.getChildren(lib)).toHaveLength(0)

    // Simulate file creation: update fs mock then call refresh
    fs.dirs.set(lib.toString(), [{ name: 'index.ts', isFile: true, isDirectory: false }])
    await tree.refresh(lib)
    expect(tree.getChildren(lib)?.some((e) => e.name === 'index.ts')).toBe(true)
  })
})

/*
 * A chain that starts one level below a directory the root's own prefetch
 * already cached. The root eager-loads `source` but stops there (two children,
 * not a chain), so `config`'s chain is the one that has to form when `source`
 * is expanded — the case where expand() short-circuits because `source`'s
 * children are already known.
 */
describe('ExplorerTreeService — compact folders below a cached parent', () => {
  const root = URI.file('/nested')
  const source = URI.joinPath(root, 'source')
  const config = URI.joinPath(source, 'config')
  const raw = URI.joinPath(config, 'raw')
  const tables = URI.joinPath(raw, 'tables')
  const leaf = URI.joinPath(tables, 'leaf')

  const CHAIN = 'config/raw/tables/leaf'

  function makeNestedFs() {
    return makeFs({
      [root.toString()]: [{ name: 'source', isFile: false, isDirectory: true }],
      // The sibling file is what keeps `source` itself out of the chain.
      [source.toString()]: [
        { name: 'config', isFile: false, isDirectory: true },
        { name: 'a.txt', isFile: true, isDirectory: false },
      ],
      [config.toString()]: [{ name: 'raw', isFile: false, isDirectory: true }],
      [raw.toString()]: [{ name: 'tables', isFile: false, isDirectory: true }],
      [tables.toString()]: [{ name: 'leaf', isFile: false, isDirectory: true }],
      [leaf.toString()]: [{ name: 'data.json', isFile: true, isDirectory: false }],
    })
  }

  function rowFor(tree: ExplorerTreeService, resource: URI) {
    return tree.getVisibleEntries().find((e) => e.resource.toString() === resource.toString())
  }

  it('expanding a branch child first shows it plain, then one click opens its chain tail', async () => {
    const inst = makeInst(makeNestedFs(), new FakeWorkspaceService(root), new FakeWatcher())
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(source)

    // `source` is a fork (config + a.txt): its children stay plain until the
    // chain head itself is expanded.
    expect(rowFor(tree, config)?.compactName).toBeUndefined()
    expect(rowFor(tree, leaf)).toBeUndefined()

    tree.setSelection([config], config)
    await tree.toggle(config)

    expect(rowFor(tree, leaf)?.compactName).toBe(CHAIN)
    expect(rowFor(tree, leaf)?.compactRoot?.toString()).toBe(config.toString())
    // The row the user clicked was renamed to the chain tail: no `config` row
    // is left behind and the focus followed the id in the same transaction.
    expect(rowFor(tree, config)).toBeUndefined()
    expect(tree.focused?.toString()).toBe(leaf.toString())
    expect(tree.isExpanded(leaf)).toBe(true)
  })

  it('keeps the chain compacted across a refresh of the parent', async () => {
    const inst = makeInst(makeNestedFs(), new FakeWorkspaceService(root), new FakeWatcher())
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(source)
    await tree.expand(config)
    await tree.refresh(source)

    expect(rowFor(tree, leaf)?.compactName).toBe(CHAIN)
    expect(rowFor(tree, config)).toBeUndefined()
  })

  it('rebuilds the chain after the cached subtree is dropped', async () => {
    const watcher = new FakeWatcher()
    const inst = makeInst(makeNestedFs(), new FakeWorkspaceService(root), watcher)
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(source)
    await tree.expand(config)

    tree.forgetSubtree(config)
    await tree.refresh(source)

    // The chain caches are gone, so the row falls back to the plain directory
    // and is re-resolved only when the user opens it again (never eagerly).
    expect(rowFor(tree, config)).toBeDefined()
    expect(rowFor(tree, leaf)).toBeUndefined()

    await tree.expand(config)
    expect(rowFor(tree, leaf)?.compactName).toBe(CHAIN)
  })

  it('survives the cold-start catch-up re-read without decompacting', async () => {
    const fs = makeNestedFs()
    const inst = makeInst(fs, new FakeWorkspaceService(root), new FakeWatcher())
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(source)
    await tree.expand(config)
    const before = fs.calls.list.length

    tree.startWatching()
    await flush()
    await flush()

    expect(rowFor(tree, leaf)?.compactName).toBe(CHAIN)
    // The catch-up re-reads the visible expanded layer and its compact chain
    // path, but never scans the sibling file or an unopened branch.
    expect(fs.calls.list.length).toBeGreaterThan(before)
    expect(fs.calls.list.filter((p) => p === config.toString())).toHaveLength(2)
  })

  it('compacts a chain that first appears after the cold-start catch-up', async () => {
    const fs = makeNestedFs()
    const inst = makeInst(fs, new FakeWorkspaceService(root), new FakeWatcher())
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(source)
    await tree.expand(config)

    // A whole chain lands on disk while the watcher was not yet armed; the
    // catch-up re-read is the only thing that will ever see it.
    const added = URI.joinPath(source, 'added')
    const addedInner = URI.joinPath(added, 'inner')
    fs.dirs.set(source.toString(), [
      { name: 'config', isFile: false, isDirectory: true },
      { name: 'added', isFile: false, isDirectory: true },
      { name: 'a.txt', isFile: true, isDirectory: false },
    ])
    fs.dirs.set(added.toString(), [{ name: 'inner', isFile: false, isDirectory: true }])
    fs.dirs.set(addedInner.toString(), [{ name: 'x.txt', isFile: true, isDirectory: false }])

    tree.startWatching()
    await flush()
    await flush()

    expect(rowFor(tree, added)?.compactName).toBeUndefined()
    await tree.expand(added)
    expect(rowFor(tree, addedInner)?.compactName).toBe('added/inner')
    expect(rowFor(tree, leaf)?.compactName).toBe(CHAIN)
  })

  it('shares one listing between concurrent expands of the same chain head', async () => {
    const fs = makeNestedFs()
    const inst = makeInst(fs, new FakeWorkspaceService(root), new FakeWatcher())
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(source)

    await Promise.all([tree.expand(config), tree.expand(config)])

    expect(fs.calls.list.filter((p) => p === config.toString())).toHaveLength(1)
    expect(rowFor(tree, leaf)?.compactName).toBe(CHAIN)
  })

  it('keeps an in-progress Shift anchor when the chain shortens', async () => {
    const fs = makeNestedFs()
    const inst = makeInst(fs, new FakeWorkspaceService(root), new FakeWatcher())
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(source)
    await tree.expand(config)
    // Keep the compact row collapsed so the Shift range only spans rows that
    // survive the reshape.
    tree.collapse(leaf)
    const a = URI.joinPath(source, 'a.txt')
    // Visible rows: root, source, leaf (compact chain), a.txt.
    tree.setSelection([leaf], leaf)
    tree.extendSelectionTo(a)

    // A sibling under `raw` shortens the chain: the leaf row id becomes `raw`.
    fs.dirs.set(raw.toString(), [
      { name: 'tables', isFile: false, isDirectory: true },
      { name: 'extra', isFile: false, isDirectory: true },
    ])
    fs.dirs.set(URI.joinPath(raw, 'extra').toString(), [])
    await tree.refresh(raw)

    // Extending again must start from the remapped anchor (raw), not from the
    // focus (a.txt), which would collapse the range to a single row.
    tree.extendSelectionTo(a)
    expect(tree.selection.map((u) => u.toString())).toEqual([raw.toString(), a.toString()])
  })

  it('ignores a stale anchor snapshot when the user re-anchors mid-refresh', async () => {
    const fs = makeNestedFs()
    const inst = makeInst(fs, new FakeWorkspaceService(root), new FakeWatcher())
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(source)
    await tree.expand(config)
    const a = URI.joinPath(source, 'a.txt')
    tree.setSelection([leaf], leaf)
    tree.extendSelectionTo(a)

    // Pause the reload so the user can act between anchor capture and remap.
    let releaseList!: () => void
    const listGate = new Promise<void>((resolve) => (releaseList = resolve))
    let markListStarted!: () => void
    const listStarted = new Promise<void>((resolve) => (markListStarted = resolve))
    const list = fs.list.bind(fs)
    fs.list = async (resource: URI) => {
      if (resource.toString() === raw.toString()) {
        markListStarted()
        await listGate
      }
      return list(resource)
    }

    fs.dirs.set(raw.toString(), [
      { name: 'tables', isFile: false, isDirectory: true },
      { name: 'extra', isFile: false, isDirectory: true },
    ])
    fs.dirs.set(URI.joinPath(raw, 'extra').toString(), [])
    const refresh = tree.refresh(raw)
    await listStarted

    // A single click while the reload is paused re-anchors at a.txt.
    tree.setSelection([a], a)
    releaseList()
    await refresh

    // Extending to the same row stays a no-op range instead of resurrecting
    // the pre-refresh anchor (leaf, remapped to raw).
    tree.extendSelectionTo(a)
    expect(tree.selection.map((u) => u.toString())).toEqual([a.toString()])
  })

  it('moves focus onto the new tail when the chain shortens', async () => {
    const fs = makeNestedFs()
    const inst = makeInst(fs, new FakeWorkspaceService(root), new FakeWatcher())
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(source)
    await tree.expand(config)
    tree.setSelection([leaf], leaf)

    // A sibling appears under `raw`, so the chain stops there and the row id
    // moves from the old leaf up to `raw` — the shape a watcher event on `raw`
    // produces.
    fs.dirs.set(raw.toString(), [
      { name: 'tables', isFile: false, isDirectory: true },
      { name: 'extra', isFile: false, isDirectory: true },
    ])
    fs.dirs.set(URI.joinPath(raw, 'extra').toString(), [])
    await tree.refresh(raw)

    expect(rowFor(tree, raw)?.compactName).toBe('config/raw')
    expect(tree.focused?.toString()).toBe(raw.toString())
    expect(tree.selection.map((u) => u.toString())).toEqual([raw.toString()])
  })

  it('re-resolves a folded chain expansion onto the shortened tail', async () => {
    const localRoot = URI.file('/nested-folded')
    const localSource = URI.joinPath(localRoot, 'source')
    const localConfig = URI.joinPath(localSource, 'config')
    const localRaw = URI.joinPath(localConfig, 'raw')
    const localTables = URI.joinPath(localRaw, 'tables')
    const fs = makeFs({
      [localRoot.toString()]: [
        { name: 'source', isFile: false, isDirectory: true },
        { name: 'README.md', isFile: true, isDirectory: false },
      ],
      [localSource.toString()]: [
        { name: 'config', isFile: false, isDirectory: true },
        { name: 'a.txt', isFile: true, isDirectory: false },
      ],
      [localConfig.toString()]: [{ name: 'raw', isFile: false, isDirectory: true }],
      [localRaw.toString()]: [{ name: 'tables', isFile: false, isDirectory: true }],
      [localTables.toString()]: [{ name: 'data.json', isFile: true, isDirectory: false }],
    })
    const inst = makeInst(fs, new FakeWorkspaceService(localRoot), new FakeWatcher())
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(localSource)
    await tree.expand(localConfig)
    expect(rowFor(tree, localTables)?.compactName).toBe('config/raw/tables')
    tree.setSelection([localTables], localTables)
    tree.collapse(localTables)

    // A sibling lands under `raw`, but the collapsed chain's watcher event is
    // lost: only the explicit refresh may notice, and it only marks the folded
    // chain stale — it must not read the tail to paper over the identity.
    const extra = URI.joinPath(localRaw, 'extra')
    fs.dirs.set(localRaw.toString(), [
      { name: 'tables', isFile: false, isDirectory: true },
      { name: 'extra', isFile: false, isDirectory: true },
    ])
    fs.dirs.set(extra.toString(), [])
    fs.calls.list.length = 0
    await tree.refresh(localRoot, true)
    expect(fs.calls.list).not.toContain(localRaw.toString())

    // Expanding the old tail re-reads from the chain head, discovers the fork
    // at `raw`, and migrates the row (and focus/selection) up to the new tail.
    await tree.expand(localTables)

    expect(rowFor(tree, localRaw)?.compactName).toBe('config/raw')
    expect(tree.isExpanded(localRaw)).toBe(true)
    expect(tree.isExpanded(localTables)).toBe(false)
    expect(tree.focused?.toString()).toBe(localRaw.toString())
    expect(tree.selection.map((resource) => resource.toString())).toEqual([localRaw.toString()])
    // `tables` is now a plain child row of the expanded `raw` row, not the row
    // identity itself.
    expect(tree.getVisibleEntries().filter((e) => e.name === 'tables')).toHaveLength(1)
    expect(fs.calls.list).toContain(localConfig.toString())
    expect(fs.calls.list).toContain(localRaw.toString())
    expect(fs.calls.list).not.toContain(localTables.toString())
  })

  it('keeps a user selection made while a chain reshape was in flight', async () => {
    const fs = makeNestedFs()
    const inst = makeInst(fs, new FakeWorkspaceService(root), new FakeWatcher())
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(source)
    await tree.expand(config)
    const a = URI.joinPath(source, 'a.txt')
    tree.setSelection([leaf], leaf)

    let releaseList!: () => void
    let markListStarted!: () => void
    const listGate = new Promise<void>((resolve) => (releaseList = resolve))
    const listStarted = new Promise<void>((resolve) => (markListStarted = resolve))
    const list = fs.list.bind(fs)
    fs.list = async (resource: URI) => {
      if (resource.toString() === raw.toString()) {
        markListStarted()
        await listGate
      }
      return list(resource)
    }

    fs.dirs.set(raw.toString(), [
      { name: 'tables', isFile: false, isDirectory: true },
      { name: 'extra', isFile: false, isDirectory: true },
    ])
    fs.dirs.set(URI.joinPath(raw, 'extra').toString(), [])
    const refresh = tree.refresh(raw)
    await listStarted

    // The user picks another row while the reshape is still pending; that
    // choice must survive, not be replaced by the remapped old focus.
    tree.setSelection([a], a)
    releaseList()
    await refresh

    expect(tree.focused?.toString()).toBe(a.toString())
    expect(tree.selection.map((u) => u.toString())).toEqual([a.toString()])
  })

  it('does not re-expand a row the user collapsed while the reload was in flight', async () => {
    const fs = makeNestedFs()
    const inst = makeInst(fs, new FakeWorkspaceService(root), new FakeWatcher())
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(source)
    await tree.expand(config)
    expect(tree.isExpanded(leaf)).toBe(true)

    let releaseList!: () => void
    let markListStarted!: () => void
    const listGate = new Promise<void>((resolve) => (releaseList = resolve))
    const listStarted = new Promise<void>((resolve) => (markListStarted = resolve))
    const list = fs.list.bind(fs)
    fs.list = async (resource: URI) => {
      if (resource.toString() === raw.toString()) {
        markListStarted()
        await listGate
      }
      return list(resource)
    }

    fs.dirs.set(raw.toString(), [
      { name: 'tables', isFile: false, isDirectory: true },
      { name: 'extra', isFile: false, isDirectory: true },
    ])
    fs.dirs.set(URI.joinPath(raw, 'extra').toString(), [])
    const refresh = tree.refresh(raw)
    await listStarted

    tree.collapse(leaf)
    releaseList()
    await refresh

    // The chain reshape must not carry the collapsed state onto its new row.
    expect(tree.isExpanded(leaf)).toBe(false)
    expect(tree.isExpanded(raw)).toBe(false)
  })

  it('leaves focus alone when it still matches a row, or when the row is gone', async () => {
    const fs = makeNestedFs()
    const inst = makeInst(fs, new FakeWorkspaceService(root), new FakeWatcher())
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(source)

    const sibling = URI.joinPath(source, 'a.txt')
    tree.setSelection([sibling], sibling)
    await tree.refresh(source)
    expect(tree.focused?.toString()).toBe(sibling.toString())

    // A resource that no longer exists cannot be re-resolved onto any row —
    // remapping it would send focus somewhere the user never pointed at.
    const gone = URI.joinPath(source, 'deleted')
    tree.setSelection([gone], gone)
    await tree.refresh(source)
    expect(tree.focused?.toString()).toBe(gone.toString())
  })
})

describe('ExplorerTreeService — on-demand invalidation and identity', () => {
  const root = URI.file('/ws')

  function makeTree(initial: Record<string, IDirectoryEntry[]>) {
    const fs = makeFs(initial)
    const watcher = new FakeWatcher()
    const inst = makeInst(fs, new FakeWorkspaceService(root), watcher)
    const tree = inst.createInstance(ExplorerTreeService)
    return { fs, watcher, tree }
  }

  function rowFor(tree: ExplorerTreeService, resource: URI) {
    return tree
      .getVisibleEntries()
      .find((entry) => entry.resource.toString() === resource.toString())
  }

  it('watcher on a compact intermediate refreshes that chain and migrates the row id', async () => {
    const src = URI.joinPath(root, 'src')
    const lib = URI.joinPath(src, 'lib')
    const other = URI.joinPath(root, 'other')
    const { fs, watcher, tree } = makeTree({
      [root.toString()]: [
        { name: 'src', isFile: false, isDirectory: true },
        { name: 'other', isFile: false, isDirectory: true },
      ],
      [src.toString()]: [{ name: 'lib', isFile: false, isDirectory: true }],
      [lib.toString()]: [{ name: 'x.txt', isFile: true, isDirectory: false }],
      [other.toString()]: [],
    })
    await flush()
    await tree.expand(src)
    tree.setSelection([lib], lib)
    expect(rowFor(tree, lib)?.compactName).toBe('src/lib')

    // A sibling lands in the intermediate `src`: the chain stops there, so the
    // visible row id moves from the tail (lib) back to src.
    await fs.writeFile(URI.joinPath(src, 'new.txt'), new Uint8Array())
    watcher.fire([{ type: 'added', resource: URI.joinPath(src, 'new.txt') }])
    await flush()

    expect(rowFor(tree, src)).toBeDefined()
    expect(rowFor(tree, src)?.compactName).toBeUndefined()
    expect(rowFor(tree, lib)).toBeDefined() // now a plain child of the expanded src
    expect(tree.focused?.toString()).toBe(src.toString())
    expect(tree.selection.map((resource) => resource.toString())).toEqual([src.toString()])
    expect(tree.isExpanded(src)).toBe(true)
    expect(fs.calls.list).not.toContain(other.toString())
  })

  it('pulls a hidden expanded chain on demand when it becomes visible again', async () => {
    const a = URI.joinPath(root, 'a')
    const x = URI.joinPath(a, 'x')
    const y = URI.joinPath(a, 'y')
    const deep = URI.joinPath(x, 'deep')
    const { fs, tree } = makeTree({
      [root.toString()]: [
        { name: 'a', isFile: false, isDirectory: true },
        { name: 'README.md', isFile: true, isDirectory: false },
      ],
      [a.toString()]: [
        { name: 'x', isFile: false, isDirectory: true },
        { name: 'y', isFile: false, isDirectory: true },
      ],
      [x.toString()]: [{ name: 'deep', isFile: false, isDirectory: true }],
      [y.toString()]: [],
      [deep.toString()]: [{ name: 'f.txt', isFile: true, isDirectory: false }],
    })
    await flush()
    await tree.expand(a)
    await tree.expand(x)
    expect(rowFor(tree, deep)?.compactName).toBe('x/deep')
    tree.collapse(a)

    // Catch-up only touches the visible layer; the hidden chain is marked
    // stale, not read.
    fs.calls.list.length = 0
    tree.startWatching()
    await flush()
    await flush()
    expect(fs.calls.list).not.toContain(x.toString())
    expect(fs.calls.list).not.toContain(deep.toString())

    fs.calls.list.length = 0
    await tree.expand(a)
    tree.getVisibleEntries() // collect → the expanded x/deep row pulls itself
    await flush()
    await flush()

    expect(fs.calls.list).toContain(x.toString())
    expect(fs.calls.list).toContain(deep.toString())
    expect(rowFor(tree, deep)?.compactName).toBe('x/deep')
    expect(tree.getChildren(deep)?.map((entry) => entry.name)).toEqual(['f.txt'])

    const reads = fs.calls.list.length
    tree.getVisibleEntries()
    tree.getVisibleEntries()
    await flush()
    expect(fs.calls.list.length).toBe(reads)
  })

  it('retries a failed hidden-chain pull only on the next user expand', async () => {
    const a = URI.joinPath(root, 'a')
    const x = URI.joinPath(a, 'x')
    const deep = URI.joinPath(x, 'deep')
    const { fs, tree } = makeTree({
      [root.toString()]: [
        { name: 'a', isFile: false, isDirectory: true },
        { name: 'README.md', isFile: true, isDirectory: false },
      ],
      [a.toString()]: [
        { name: 'x', isFile: false, isDirectory: true },
        { name: 'y', isFile: false, isDirectory: true },
      ],
      [x.toString()]: [{ name: 'deep', isFile: false, isDirectory: true }],
      [deep.toString()]: [{ name: 'f.txt', isFile: true, isDirectory: false }],
    })
    await flush()
    await tree.expand(a)
    await tree.expand(x)
    tree.collapse(a)
    tree.startWatching()
    await flush()
    await flush()

    const original = fs.list.bind(fs)
    let fail = true
    fs.list = async (resource: URI) => {
      if (fail && resource.toString() === x.toString()) {
        fs.calls.list.push(resource.toString())
        throw new Error('boom')
      }
      return original(resource)
    }
    fs.calls.list.length = 0

    await tree.expand(a)
    tree.getVisibleEntries()
    await flush()
    await flush()

    expect(tree.getNode(x).error).toBe('boom')
    const failedReads = fs.calls.list.filter((p) => p === x.toString()).length
    expect(failedReads).toBe(1)
    tree.getVisibleEntries()
    tree.getVisibleEntries()
    await flush()
    expect(fs.calls.list.filter((p) => p === x.toString())).toHaveLength(1)

    // The explicit gesture retries and the chain compacts again.
    fail = false
    await tree.expand(x)
    expect(tree.getNode(x).error).toBeNull()
    expect(rowFor(tree, deep)?.compactName).toBe('x/deep')
  })

  it('CRUD inside an intermediate directory shortens the chain and keeps selection', async () => {
    const src = URI.joinPath(root, 'src')
    const lib = URI.joinPath(src, 'lib')
    const other = URI.joinPath(root, 'other')
    const { fs, tree } = makeTree({
      [root.toString()]: [
        { name: 'src', isFile: false, isDirectory: true },
        { name: 'other', isFile: false, isDirectory: true },
      ],
      [src.toString()]: [{ name: 'lib', isFile: false, isDirectory: true }],
      [lib.toString()]: [{ name: 'x.txt', isFile: true, isDirectory: false }],
      [other.toString()]: [],
    })
    await flush()
    await tree.expand(src)
    tree.setSelection([lib], lib)
    expect(rowFor(tree, lib)?.compactName).toBe('src/lib')

    await tree.createFile(src, 'new.txt')

    expect(rowFor(tree, src)?.compactName).toBeUndefined()
    expect(tree.focused?.toString()).toBe(src.toString())
    expect(tree.selection.map((resource) => resource.toString())).toEqual([src.toString()])
    expect(tree.isExpanded(src)).toBe(true)
    expect(rowFor(tree, lib)).toBeDefined()
    expect(fs.calls.list).not.toContain(other.toString())
  })

  it('keeps an invalidation that lands while the first list is in flight', async () => {
    const a = URI.joinPath(root, 'a')
    const x = URI.joinPath(a, 'x')
    const y = URI.joinPath(a, 'y')
    const { fs, watcher, tree } = makeTree({
      [root.toString()]: [
        { name: 'a', isFile: false, isDirectory: true },
        { name: 'README.md', isFile: true, isDirectory: false },
      ],
      [a.toString()]: [
        { name: 'x', isFile: false, isDirectory: true },
        { name: 'y', isFile: false, isDirectory: true },
      ],
      [x.toString()]: [{ name: 'v1.txt', isFile: true, isDirectory: false }],
      [y.toString()]: [],
    })
    await flush()
    await tree.expand(a)

    let release!: () => void
    let markStarted!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const started = new Promise<void>((resolve) => (markStarted = resolve))
    const list = fs.list.bind(fs)
    fs.list = async (resource: URI) => {
      if (resource.toString() === x.toString()) {
        markStarted()
        await gate
      }
      return list(resource)
    }
    fs.calls.list.length = 0

    const expanding = tree.expand(x)
    await started
    // The row is hidden while its first read is still in flight, and the
    // watcher says the directory changed underneath it.
    tree.collapse(a)
    watcher.fire([{ type: 'added', resource: URI.joinPath(x, 'new.txt') }])
    release()
    await expanding
    await flush()

    // The stale result must not be published as fresh: the invalidation wins a
    // second read instead of being cleared by the first one's commit.
    expect(fs.calls.list.filter((p) => p === x.toString())).toHaveLength(2)

    fs.calls.list.length = 0
    await tree.expand(a)
    await tree.expand(x)
    await flush()
    expect(fs.calls.list.filter((p) => p === x.toString())).toHaveLength(0)
  })
})

describe('ExplorerTreeService — collapsed chains stay unread', () => {
  const root = URI.file('/ws')

  function makeTree() {
    const src = URI.joinPath(root, 'src')
    const lib = URI.joinPath(src, 'lib')
    const fs = makeFs({
      [root.toString()]: [
        { name: 'src', isFile: false, isDirectory: true },
        { name: 'README.md', isFile: true, isDirectory: false },
      ],
      [src.toString()]: [{ name: 'lib', isFile: false, isDirectory: true }],
      [lib.toString()]: [{ name: 'v1.txt', isFile: true, isDirectory: false }],
    })
    const watcher = new FakeWatcher()
    const inst = makeInst(fs, new FakeWorkspaceService(root), watcher)
    const tree = inst.createInstance(ExplorerTreeService)
    return { fs, watcher, tree, src, lib }
  }

  function rowFor(tree: ExplorerTreeService, resource: URI) {
    return tree
      .getVisibleEntries()
      .find((entry) => entry.resource.toString() === resource.toString())
  }

  it('recursive refresh does not read a collapsed compact chain', async () => {
    const { fs, tree, src, lib } = makeTree()
    await flush()
    await tree.expand(src)
    expect(rowFor(tree, lib)?.compactName).toBe('src/lib')
    tree.collapse(lib)

    fs.calls.list.length = 0
    await tree.refresh(root, true)

    expect(fs.calls.list).not.toContain(src.toString())
    expect(fs.calls.list).not.toContain(lib.toString())

    // Opening it again re-reads from the chain head on demand.
    fs.calls.list.length = 0
    await tree.expand(lib)
    expect(fs.calls.list).toContain(src.toString())
    expect(fs.calls.list).toContain(lib.toString())
  })

  it('re-expands a chain refreshed while collapsed with the new directory contents', async () => {
    const { fs, tree, src, lib } = makeTree()
    await flush()
    await tree.expand(src)
    expect(rowFor(tree, lib)?.compactName).toBe('src/lib')
    tree.collapse(lib)

    // External write while folded: the refresh must remember that the cached
    // tail listing is no longer trustworthy, without reading it eagerly.
    await fs.writeFile(URI.joinPath(lib, 'new.txt'), new Uint8Array())
    fs.calls.list.length = 0
    await tree.refresh(root, true)
    expect(fs.calls.list).not.toContain(lib.toString())
    expect(rowFor(tree, lib)?.compactName).toBe('src/lib')

    await tree.expand(lib)
    expect(tree.getChildren(lib)?.map((child) => child.name)).toContain('new.txt')
    expect(rowFor(tree, URI.joinPath(lib, 'new.txt'))?.name).toBe('new.txt')
  })

  it('a watcher event inside a collapsed chain tail only invalidates it', async () => {
    const { fs, watcher, tree, src, lib } = makeTree()
    await flush()
    await tree.expand(src)
    tree.collapse(lib)

    fs.calls.list.length = 0
    const added = URI.joinPath(lib, 'new.txt')
    await fs.writeFile(added, new Uint8Array())
    watcher.fire([{ type: 'added', resource: added }])
    await flush()

    expect(fs.calls.list).not.toContain(lib.toString())
    expect(fs.calls.list).not.toContain(src.toString())
  })

  it('a watcher event on a chain intermediate verifies identity without reading the tail', async () => {
    const { fs, watcher, tree, src, lib } = makeTree()
    await flush()
    await tree.expand(src)
    tree.collapse(lib)

    fs.calls.list.length = 0
    const ghost = URI.joinPath(src, 'ghost.txt')
    watcher.fire([{ type: 'added', resource: ghost }])
    await flush()

    expect(fs.calls.list).toContain(src.toString())
    expect(fs.calls.list).not.toContain(lib.toString())
    expect(rowFor(tree, lib)?.compactName).toBe('src/lib')
  })
})

describe('ExplorerTreeService — focus folders', () => {
  const root = URI.file('/ws')
  const client = URI.joinPath(root, 'Client')
  const clientSub = URI.joinPath(client, 'Sub')
  const tools = URI.joinPath(root, 'Tools')
  const toolsEditor = URI.joinPath(tools, 'Editor')

  function makeFocusFs() {
    return makeFs({
      [root.toString()]: [
        { name: 'Client', isFile: false, isDirectory: true },
        { name: 'Tools', isFile: false, isDirectory: true },
        { name: 'Engine', isFile: false, isDirectory: true },
        { name: 'README.md', isFile: true, isDirectory: false },
      ],
      [client.toString()]: [
        { name: 'client.txt', isFile: true, isDirectory: false },
        { name: 'Sub', isFile: false, isDirectory: true },
      ],
      [clientSub.toString()]: [{ name: 'sub.txt', isFile: true, isDirectory: false }],
      [tools.toString()]: [
        { name: 'tools.txt', isFile: true, isDirectory: false },
        { name: 'Editor', isFile: false, isDirectory: true },
      ],
      [toolsEditor.toString()]: [{ name: 'editor.ts', isFile: true, isDirectory: false }],
      [URI.joinPath(root, 'Engine').toString()]: [
        { name: 'engine.txt', isFile: true, isDirectory: false },
      ],
    })
  }

  function makeFocusInst(showRootFiles = true, exclude?: IExcludeService) {
    const fs = makeFocusFs()
    const focus = new FakeFocusScopeService(['Client', 'Tools/Editor'], root, showRootFiles)
    const inst = makeInst(
      fs,
      new FakeWorkspaceService(root),
      new FakeWatcher(),
      undefined,
      undefined,
      focus,
      exclude,
    )
    return { fs, focus, inst }
  }

  function childNames(tree: ExplorerTreeService, uri: URI): string[] {
    return (tree.getChildren(uri) ?? []).map((c) => c.name)
  }

  it('keeps focus folders and their subtrees visible', async () => {
    const { inst } = makeFocusInst()
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()

    expect(childNames(tree, root)).toEqual(['Client', 'Tools', 'README.md'])
    await tree.expand(client)
    expect(childNames(tree, client)).toEqual(['Sub', 'client.txt'])
    await tree.expand(clientSub)
    expect(childNames(tree, clientSub)).toEqual(['sub.txt'])
    await tree.expand(toolsEditor)
    expect(childNames(tree, toolsEditor)).toEqual(['editor.ts'])
  })

  it('keeps skeleton directories visible but hides their direct files', async () => {
    const { inst } = makeFocusInst()
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(tools)
    // tools.txt sits directly in the skeleton dir Tools; only Editor survives.
    expect(childNames(tree, tools)).toEqual(['Editor'])
  })

  it('hides unrelated top-level directories', async () => {
    const { inst } = makeFocusInst()
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    expect(childNames(tree, root)).not.toContain('Engine')
  })

  it('shows root-level files by default and hides them when showRootFiles is off', async () => {
    const visible = makeFocusInst().inst.createInstance(ExplorerTreeService)
    await flush()
    expect(childNames(visible, root)).toContain('README.md')

    const hidden = makeFocusInst(false).inst.createInstance(ExplorerTreeService)
    await flush()
    expect(childNames(hidden, root)).toEqual(['Client', 'Tools'])
  })

  it('applies files.exclude independently of focus', async () => {
    const exclude = new FakeExcludeService(new Set(['Client', 'Tools/Editor/editor.ts']))
    const { inst } = makeFocusInst(true, exclude)
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()

    // The whole focus folder Client is excluded → gone even though focused.
    expect(childNames(tree, root)).toEqual(['Tools', 'README.md'])
    // editor.ts is inside the focus folder Tools/Editor but excluded → hidden.
    await tree.expand(toolsEditor)
    expect(childNames(tree, toolsEditor)).toEqual([])
  })

  it('re-reads loaded directories when the focus scope changes', async () => {
    const { fs, focus, inst } = makeFocusInst()
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    expect(childNames(tree, root)).toEqual(['Client', 'Tools', 'README.md'])

    fs.calls.list.length = 0
    focus.fireChange()
    await flush()
    expect(fs.calls.list).toContain(root.toString())
  })
})

/*
 * 过滤变更（exclude/focus）只重读根与可见层，绝不为了重算旧过滤而全量重读
 * 隐藏缓存：折叠后的巨型目录只标脏，重新展开时从链头按需应用新过滤。
 */
describe('ExplorerTreeService — 过滤变更按需重读', () => {
  const root = URI.file('/ws')

  function makeBigFs() {
    const big = URI.joinPath(root, 'big')
    const fs = makeFs({
      [root.toString()]: [
        { name: 'big', isFile: false, isDirectory: true },
        { name: 'README.md', isFile: true, isDirectory: false },
      ],
      [big.toString()]: [
        { name: 'keep.ts', isFile: true, isDirectory: false },
        { name: 'drop.ts', isFile: true, isDirectory: false },
        { name: 'other.ts', isFile: true, isDirectory: false },
      ],
    })
    return { fs, big }
  }

  it('exclude 变更不重读折叠目录，重新展开时才按新过滤读取', async () => {
    const { fs, big } = makeBigFs()
    const excluded = new Set<string>()
    const exclude = new FakeExcludeService(excluded)
    const inst = makeInst(
      fs,
      new FakeWorkspaceService(root),
      new FakeWatcher(),
      undefined,
      undefined,
      undefined,
      exclude,
    )
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(big)
    expect(fs.calls.list).toContain(big.toString())
    tree.collapse(big)

    fs.calls.list.length = 0
    excluded.add('big/drop.ts')
    exclude.fireChange()
    await flush()

    expect(fs.calls.list).toContain(root.toString())
    expect(fs.calls.list).not.toContain(big.toString())

    await tree.expand(big)

    expect(fs.calls.list).toContain(big.toString())
    expect((tree.getChildren(big) ?? []).map((entry) => entry.name)).toEqual([
      'keep.ts',
      'other.ts',
    ])
  })

  it('focus 变更不重读折叠目录，重新展开时才按新过滤读取', async () => {
    const { fs, big } = makeBigFs()
    const sub = URI.joinPath(big, 'sub')
    fs.dirs.set(big.toString(), [
      { name: 'sub', isFile: false, isDirectory: true },
      { name: 'keep.ts', isFile: true, isDirectory: false },
      { name: 'drop.ts', isFile: true, isDirectory: false },
    ])
    fs.dirs.set(sub.toString(), [{ name: 'sub.txt', isFile: true, isDirectory: false }])
    const focus = new FakeFocusScopeService(['big'], root)
    const inst = makeInst(
      fs,
      new FakeWorkspaceService(root),
      new FakeWatcher(),
      undefined,
      undefined,
      focus,
    )
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(big)
    tree.collapse(big)

    fs.calls.list.length = 0
    await focus.setFolders(['big/sub'])
    await flush()

    expect(fs.calls.list).toContain(root.toString())
    expect(fs.calls.list).not.toContain(big.toString())

    await tree.expand(big)

    expect(fs.calls.list).toContain(big.toString())
    // big 成了 focus 目标的骨架目录：自身文件隐藏，只剩通往 sub 的目录。
    expect((tree.getChildren(big) ?? []).map((entry) => entry.name)).toEqual(['sub'])
  })

  it('折叠 compact 链时只重读中间节点，链尾等重新展开再读取', async () => {
    const pkg = URI.joinPath(root, 'pkg')
    const a = URI.joinPath(pkg, 'a')
    const b = URI.joinPath(a, 'b')
    const big = URI.joinPath(b, 'big')
    const fs = makeFs({
      [root.toString()]: [
        { name: 'pkg', isFile: false, isDirectory: true },
        { name: 'README.md', isFile: true, isDirectory: false },
      ],
      [pkg.toString()]: [
        { name: 'a', isFile: false, isDirectory: true },
        { name: 'sibling.txt', isFile: true, isDirectory: false },
      ],
      [a.toString()]: [{ name: 'b', isFile: false, isDirectory: true }],
      [b.toString()]: [{ name: 'big', isFile: false, isDirectory: true }],
      [big.toString()]: [
        { name: 'keep.ts', isFile: true, isDirectory: false },
        { name: 'drop.ts', isFile: true, isDirectory: false },
      ],
    })
    const excluded = new Set<string>()
    const exclude = new FakeExcludeService(excluded)
    const inst = makeInst(
      fs,
      new FakeWorkspaceService(root),
      new FakeWatcher(),
      undefined,
      undefined,
      undefined,
      exclude,
    )
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(pkg)
    await tree.expand(a)
    expect(tree.isExpanded(big)).toBe(true)
    tree.collapse(big)
    expect(tree.getVisibleEntries().some((entry) => entry.compactName === 'a/b/big')).toBe(true)

    fs.calls.list.length = 0
    excluded.add('pkg/a/b/big/drop.ts')
    exclude.fireChange()
    await flush()

    // 中间节点至多各有一个子项，重读它们让折叠行标签立即正确；链尾可能是
    // 巨型目录，只标脏不读取。
    expect(fs.calls.list).toContain(a.toString())
    expect(fs.calls.list).toContain(b.toString())
    expect(fs.calls.list).not.toContain(big.toString())

    await tree.expand(big)

    expect(fs.calls.list).toContain(big.toString())
    expect((tree.getChildren(big) ?? []).map((entry) => entry.name)).toEqual(['keep.ts'])
  })
})
