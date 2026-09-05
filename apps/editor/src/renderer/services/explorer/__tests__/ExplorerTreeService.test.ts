/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/explorer/ExplorerTreeService.ts
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest'
import { InstantiationService, URI, type UriComponents } from '@universe-editor/platform'
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

  it('selectRange spans the inclusive range between anchor and target in visible order', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(URI.joinPath(root, 'src'))
    const visible = tree.getVisibleEntries()
    // [root, src, index.ts, README.md]
    const anchor = visible[1]!.resource // src
    const target = visible[3]!.resource // README.md
    tree.selectRange(anchor, target)
    expect(tree.selection.map((u) => u.toString())).toEqual([
      visible[1]!.resource.toString(),
      visible[2]!.resource.toString(),
      visible[3]!.resource.toString(),
    ])
    expect(tree.focused?.toString()).toBe(target.toString())
  })

  it('selectRange works in reverse order too', async () => {
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(URI.joinPath(root, 'src'))
    const visible = tree.getVisibleEntries()
    const anchor = visible[3]!.resource
    const target = visible[1]!.resource
    tree.selectRange(anchor, target)
    expect(tree.selection.map((u) => u.toString())).toEqual([
      visible[1]!.resource.toString(),
      visible[2]!.resource.toString(),
      visible[3]!.resource.toString(),
    ])
    expect(tree.focused?.toString()).toBe(target.toString())
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

  it('expanding the parent renders the chain compacted on the first frame', async () => {
    const inst = makeInst(makeNestedFs(), new FakeWorkspaceService(root), new FakeWatcher())
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(source)

    expect(rowFor(tree, leaf)?.compactName).toBe(CHAIN)
    expect(rowFor(tree, leaf)?.compactRoot?.toString()).toBe(config.toString())
    // The plain `config` row is the bug: it only compacts once expanded, and
    // compacting changes the row id, which silently drops focus.
    expect(rowFor(tree, config)).toBeUndefined()
  })

  it('keeps the chain compacted across a refresh of the parent', async () => {
    const inst = makeInst(makeNestedFs(), new FakeWorkspaceService(root), new FakeWatcher())
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(source)
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

    tree.forgetSubtree(config)
    await tree.refresh(source)

    expect(rowFor(tree, leaf)?.compactName).toBe(CHAIN)
  })

  it('survives the cold-start catch-up re-read without decompacting', async () => {
    const fs = makeNestedFs()
    const inst = makeInst(fs, new FakeWorkspaceService(root), new FakeWatcher())
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(source)
    const before = fs.calls.list.length

    tree.startWatching()
    await flush()
    await flush()

    expect(rowFor(tree, leaf)?.compactName).toBe(CHAIN)
    // The catch-up re-reads each loaded directory once; the chain prefetch adds
    // nothing on top because every directory in it is already cached.
    expect(fs.calls.list.length).toBeGreaterThan(before)
    expect(fs.calls.list.filter((p) => p === config.toString())).toHaveLength(2)
  })

  it('compacts a chain that first appears during the cold-start catch-up', async () => {
    const fs = makeNestedFs()
    const inst = makeInst(fs, new FakeWorkspaceService(root), new FakeWatcher())
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(source)

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

    expect(rowFor(tree, addedInner)?.compactName).toBe('added/inner')
    expect(rowFor(tree, leaf)?.compactName).toBe(CHAIN)
  })

  it('shares one listing between concurrent expands of the same parent', async () => {
    const fs = makeNestedFs()
    const inst = makeInst(fs, new FakeWorkspaceService(root), new FakeWatcher())
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await Promise.all([tree.expand(source), tree.expand(source)])

    expect(fs.calls.list.filter((p) => p === config.toString())).toHaveLength(1)
  })

  it('moves focus onto the new tail when the chain shortens', async () => {
    const fs = makeNestedFs()
    const inst = makeInst(fs, new FakeWorkspaceService(root), new FakeWatcher())
    const tree = inst.createInstance(ExplorerTreeService)
    await flush()
    await tree.expand(source)
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
