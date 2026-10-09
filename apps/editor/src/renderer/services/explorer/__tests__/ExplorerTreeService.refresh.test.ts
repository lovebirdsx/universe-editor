import { afterEach, describe, expect, it, vi } from 'vitest'
import { DisposableStore, URI, type IDirectoryEntry } from '@universe-editor/platform'
import { ExplorerTreeService } from '../ExplorerTreeService.js'
import { FakeExcludeService } from '../../exclude/testing/fakeExcludeService.js'
import { FakeFocusScopeService } from '../../focus/testing/fakeFocusScopeService.js'
import {
  FakeWatcher,
  FakeWorkspaceService,
  flush,
  makeFs,
  makeInst,
  type FakeFs,
} from './explorerTreeTestHarness.js'
import { _resetPerfPhasesForTests, getRecordedPhases } from '../../performance/perfPhases.js'

const directory = (name: string): IDirectoryEntry => ({ name, isDirectory: true, isFile: false })
const file = (name: string): IDirectoryEntry => ({ name, isDirectory: false, isFile: true })

const disposables = new DisposableStore()
afterEach(() => disposables.clear())

/** A `list` we can resolve by hand, so a read can be held open across a refresh / root switch. */
function interceptList(fs: FakeFs, target: URI) {
  const original = fs.list.bind(fs)
  const queue: Array<{
    resolve: (entries: IDirectoryEntry[]) => void
    reject: (err: Error) => void
  }> = []
  fs.list = (resource: URI) => {
    if (resource.toString() !== target.toString()) return original(resource)
    fs.calls.list.push(resource.toString())
    return new Promise<IDirectoryEntry[]>((resolve, reject) => queue.push({ resolve, reject }))
  }
  return queue
}

function listCallsFor(fs: FakeFs, resource: URI): number {
  return fs.calls.list.filter((p) => p === resource.toString()).length
}

async function setup(root = URI.file('/ws')) {
  const packages = URI.joinPath(root, 'packages')
  const platform = URI.joinPath(packages, 'platform')
  const fs = makeFs({
    [root.toString()]: [directory('packages'), file('README.md')],
    [packages.toString()]: [directory('platform'), file('README.md')],
    [platform.toString()]: [file('index.ts')],
  })
  const inst = disposables.add(makeInst(fs, new FakeWorkspaceService(root), new FakeWatcher()))
  const tree = disposables.add(inst.createInstance(ExplorerTreeService))
  await flush()
  await tree.expand(packages)
  return { root, packages, platform, fs, tree }
}

describe('Explorer 显式刷新', () => {
  it.each([URI.file('/ws'), URI.parse('remote-ssh://dev/ws')])(
    'watcher 漏报时，刷新 %s 仍能显示外部新增的嵌套目录',
    async (workspace) => {
      const { root, packages, fs, tree } = await setup(workspace)
      const primitives = URI.joinPath(packages, 'primitives')
      // 只改文件系统，不发送 watcher 事件。
      await fs.createDirectory(primitives)
      expect(tree.getChildren(packages)?.some((entry) => entry.name === 'primitives')).toBe(false)

      await tree.refresh(root, true)

      expect(tree.getChildren(packages)?.some((entry) => entry.name === 'primitives')).toBe(true)
      expect(
        tree
          .getVisibleEntries()
          .some((entry) => entry.resource.toString() === primitives.toString()),
      ).toBe(true)
      expect(tree.isExpanded(packages)).toBe(true)
    },
  )

  it('默认浅刷新不重读已加载后代', async () => {
    const { root, packages, fs, tree } = await setup()
    await fs.createDirectory(URI.joinPath(packages, 'primitives'))
    fs.calls.list.length = 0

    await tree.refresh(root)

    expect(fs.calls.list).toEqual([root.toString()])
    expect(tree.getChildren(packages)?.some((entry) => entry.name === 'primitives')).toBe(false)
  })

  it('深刷新同步嵌套删除并保留展开、选择与焦点', async () => {
    const { root, packages, platform, fs, tree } = await setup()
    await tree.expand(platform)
    const readme = URI.joinPath(packages, 'README.md')
    tree.setSelection([readme], readme)
    await fs.delete(URI.joinPath(platform, 'index.ts'))

    await tree.refresh(root, true)

    expect(tree.getChildren(platform)).toEqual([])
    expect(tree.isExpanded(packages)).toBe(true)
    expect(tree.isExpanded(platform)).toBe(true)
    expect(tree.selection.map((resource) => resource.toString())).toEqual([readme.toString()])
    expect(tree.focused?.toString()).toBe(readme.toString())
  })

  it('刷新子树不重读根或路径前缀相同的兄弟目录', async () => {
    const { root, packages, fs, tree } = await setup()
    const sibling = URI.joinPath(root, 'packages-other')
    await fs.createDirectory(sibling)
    await tree.refresh(root)
    fs.calls.list.length = 0

    await tree.refresh(packages, true)

    expect(fs.calls.list).toContain(packages.toString())
    expect(fs.calls.list).not.toContain(root.toString())
    expect(fs.calls.list).not.toContain(sibling.toString())
  })

  it('保留 compact 预取，但不遍历未加载分支的整棵子树', async () => {
    const { root, packages, fs, tree } = await setup()
    const other = URI.joinPath(root, 'other')
    const branch = URI.joinPath(other, 'branch')
    const deep = URI.joinPath(branch, 'deep')
    await fs.createDirectory(other)
    await fs.createDirectory(branch)
    await fs.createDirectory(deep)
    await fs.writeFile(URI.joinPath(other, 'README.md'), new Uint8Array())
    await fs.writeFile(URI.joinPath(branch, 'README.md'), new Uint8Array())
    await tree.refresh(root)
    expect(fs.calls.list).not.toContain(deep.toString())
    fs.calls.list.length = 0

    await tree.refresh(root, true)

    expect(fs.calls.list).toContain(packages.toString())
    expect(fs.calls.list).toContain(branch.toString())
    expect(fs.calls.list).not.toContain(deep.toString())
    expect(tree.isExpanded(other)).toBe(false)
  })

  it('深刷新引起 compact 链缩短时把选择与焦点映射到新链尾', async () => {
    const { root, packages, platform, fs, tree } = await setup()
    const leaf = URI.joinPath(platform, 'leaf')
    await fs.delete(URI.joinPath(platform, 'index.ts'))
    await fs.createDirectory(leaf)
    await fs.writeFile(URI.joinPath(leaf, 'index.ts'), new Uint8Array())
    await tree.refresh(packages, true)
    tree.setSelection([leaf], leaf)
    expect(
      tree.getVisibleEntries().find((entry) => entry.resource.toString() === leaf.toString())
        ?.compactName,
    ).toBe('platform/leaf')
    await fs.writeFile(URI.joinPath(platform, 'README.md'), new Uint8Array())

    await tree.refresh(root, true)

    expect(
      tree
        .getChildren(packages)
        ?.find((entry) => entry.resource.toString() === platform.toString()),
    ).toBeDefined()
    expect(tree.focused?.toString()).toBe(platform.toString())
    expect(tree.selection.map((resource) => resource.toString())).toEqual([platform.toString()])
  })
})

/*
 * 目录读取调度：展开、compact 预取与刷新共用每节点一个在途读取。刷新不再
 * 另起一次并发 list，而是把在途读取之后的尾读合并进同一轮。
 */
describe('Explorer 目录读取调度', () => {
  function makeDeferredSetup() {
    const root = URI.file('/ws')
    const a = URI.joinPath(root, 'a')
    const target = URI.joinPath(a, 'target')
    const fs = makeFs({
      [root.toString()]: [directory('a'), file('keep.txt')],
      [a.toString()]: [directory('target'), file('keep.txt')],
      [target.toString()]: [file('v1.txt')],
    })
    const ws = new FakeWorkspaceService(root)
    const inst = disposables.add(makeInst(fs, ws, new FakeWatcher()))
    const tree = disposables.add(inst.createInstance(ExplorerTreeService))
    return { root, a, target, fs, ws, tree }
  }

  it('展开与刷新共享一次在途读取，刷新只合并成一次尾读并落到最新内容', async () => {
    const { target, fs, tree } = makeDeferredSetup()
    await flush()
    // target 不在根预取范围内（a 有两个子项，不成链），expand 是它的首次读取。
    expect(fs.calls.list).not.toContain(target.toString())

    const queue = interceptList(fs, target)
    const expanding = tree.expand(target)
    await flush()
    expect(queue).toHaveLength(1)

    const refreshing = tree.refresh(target)
    await flush()
    expect(queue).toHaveLength(1)

    queue.shift()!.resolve([file('v1.txt')])
    await flush()
    expect(queue).toHaveLength(1) // 尾读已经发起

    queue.shift()!.resolve([file('v2.txt')])
    await Promise.all([expanding, refreshing])

    expect(tree.getChildren(target)?.map((e) => e.name)).toEqual(['v2.txt'])
    expect(listCallsFor(fs, target)).toBe(2)
  })

  it('尾读期间再次到达的刷新不被吞掉，会再触发一轮读取', async () => {
    const { target, fs, tree } = makeDeferredSetup()
    await flush()
    const queue = interceptList(fs, target)

    const expanding = tree.expand(target)
    await flush()
    void tree.refresh(target) // 第一次刷新 → 标记尾读
    await flush()

    queue.shift()!.resolve([file('v1.txt')])
    await flush()
    expect(queue).toHaveLength(1)

    void tree.refresh(target) // 尾读在途时又发生变化
    await flush()
    expect(queue).toHaveLength(1) // 合流进当前尾读，不并发

    queue.shift()!.resolve([file('v2.txt')])
    await flush()
    expect(queue).toHaveLength(1) // 尾读期间的变化仍然赢得下一轮读取

    queue.shift()!.resolve([file('v3.txt')])
    await flush()
    await expanding

    expect(tree.getChildren(target)?.map((e) => e.name)).toEqual(['v3.txt'])
    expect(listCallsFor(fs, target)).toBe(3)
  })

  it('首次读取失败后仍能被刷新重读并清掉错误', async () => {
    const { target, fs, tree } = makeDeferredSetup()
    await flush()
    const queue = interceptList(fs, target)

    const expanding = tree.expand(target)
    await flush()
    queue.shift()!.reject(new Error('boom'))
    await expanding
    expect(tree.getNode(target).error).toBe('boom')
    expect(tree.getChildren(target)).toEqual([])

    const refreshing = tree.refresh(target)
    await flush()
    expect(queue).toHaveLength(1)
    queue.shift()!.resolve([file('ok.txt')])
    await refreshing

    expect(tree.getNode(target).error).toBeNull()
    expect(tree.getChildren(target)?.map((e) => e.name)).toEqual(['ok.txt'])
  })

  it('切换工作区后，旧根在途读取的结果不写回、也不触发后续读取', async () => {
    const root = URI.file('/ws')
    const a = URI.joinPath(root, 'a')
    const b = URI.joinPath(a, 'b')
    const fs = makeFs({
      [root.toString()]: [directory('a')],
      [a.toString()]: [directory('b')],
      [b.toString()]: [file('stale.txt')],
    })
    const ws = new FakeWorkspaceService(root)
    const inst = disposables.add(makeInst(fs, ws, new FakeWatcher()))
    const tree = disposables.add(inst.createInstance(ExplorerTreeService))

    // 根的 compact 预取沿单子目录链 a → b 递归，停在 b 的读取上。
    const queue = interceptList(fs, b)
    await flush()
    expect(queue).toHaveLength(1)

    const other = URI.file('/other')
    fs.dirs.set(other.toString(), [])
    ws.setRoot(other)
    await flush()
    fs.calls.list.length = 0

    queue.shift()!.resolve([file('stale.txt')])
    await flush()
    await flush()

    expect(tree.getChildren(b)).toBeNull()
    expect(fs.calls.list).toEqual([])
  })

  it('销毁后在途读取不再写入节点', async () => {
    const { target, fs, tree } = makeDeferredSetup()
    await flush()
    const queue = interceptList(fs, target)
    const expanding = tree.expand(target)
    await flush()

    const pending = queue.shift()!
    tree.dispose()
    pending.resolve([file('late.txt')])
    await flush()
    await expanding

    expect(tree.getChildren(target)).toBeNull()
  })

  it('切换工作区后，在途读取的尾读不再为旧根发出 list', async () => {
    const { target, fs, ws, tree } = makeDeferredSetup()
    await flush()
    const queue = interceptList(fs, target)

    void tree.expand(target)
    await flush()
    void tree.refresh(target) // 打上尾读标记
    await flush()

    ws.setRoot(URI.file('/other'))
    await flush()
    fs.calls.list.length = 0

    queue.shift()!.resolve([file('v1.txt')])
    await flush()
    await flush()

    expect(fs.calls.list).toEqual([])
  })

  it('销毁后，在途读取的尾读不再发出 list', async () => {
    const { target, fs, tree } = makeDeferredSetup()
    await flush()
    const queue = interceptList(fs, target)

    void tree.expand(target)
    await flush()
    void tree.refresh(target) // 打上尾读标记
    await flush()

    fs.calls.list.length = 0
    const pending = queue.shift()!
    tree.dispose()
    pending.resolve([file('late.txt')])
    await flush()
    await flush()

    expect(fs.calls.list).toEqual([])
  })

  it.each([URI.file('/ws'), URI.parse('remote-ssh://dev/ws')])(
    '被排除的目录不进入子项，也不触发 compact 预取（%s）',
    async (root) => {
      const skipped = URI.joinPath(root, 'node_modules')
      const inner = URI.joinPath(skipped, 'pkg')
      const src = URI.joinPath(root, 'src')
      const fs = makeFs({
        [root.toString()]: [directory('node_modules'), directory('src'), file('README.md')],
        [skipped.toString()]: [directory('pkg')],
        [inner.toString()]: [file('index.js')],
        [src.toString()]: [file('index.ts')],
      })
      const exclude = new FakeExcludeService(new Set(['node_modules']))
      const inst = disposables.add(
        makeInst(
          fs,
          new FakeWorkspaceService(root),
          new FakeWatcher(),
          undefined,
          undefined,
          undefined,
          exclude,
        ),
      )
      const tree = disposables.add(inst.createInstance(ExplorerTreeService))
      await flush()

      expect(tree.getChildren(root)?.map((e) => e.name)).toEqual(['src', 'README.md'])
      expect(fs.calls.list).not.toContain(skipped.toString())
      expect(fs.calls.list).not.toContain(inner.toString())
    },
  )

  it('焦点之外的目录不触发 compact 预取', async () => {
    const root = URI.file('/ws')
    const kept = URI.joinPath(root, 'Kept')
    const other = URI.joinPath(root, 'Other')
    const nested = URI.joinPath(other, 'nested')
    const fs = makeFs({
      [root.toString()]: [directory('Kept'), directory('Other')],
      [kept.toString()]: [],
      [other.toString()]: [directory('nested')],
      [nested.toString()]: [],
    })
    const focus = new FakeFocusScopeService(['Kept'], root, false)
    const inst = disposables.add(
      makeInst(fs, new FakeWorkspaceService(root), new FakeWatcher(), undefined, undefined, focus),
    )
    const tree = disposables.add(inst.createInstance(ExplorerTreeService))
    await flush()

    expect(tree.getChildren(root)?.map((e) => e.name)).toEqual(['Kept'])
    expect(fs.calls.list).not.toContain(other.toString())
    expect(fs.calls.list).not.toContain(nested.toString())
  })

  it('被排除的条目在构造 URI 之前就被丢弃', async () => {
    const root = URI.file('/ws')
    const fs = makeFs({
      [root.toString()]: [directory('node_modules'), file('README.md')],
    })
    const exclude = new FakeExcludeService(new Set(['node_modules']))
    const joinPath = vi.spyOn(URI, 'joinPath')
    try {
      const inst = disposables.add(
        makeInst(
          fs,
          new FakeWorkspaceService(root),
          new FakeWatcher(),
          undefined,
          undefined,
          undefined,
          exclude,
        ),
      )
      disposables.add(inst.createInstance(ExplorerTreeService))
      await flush()

      const joinedNames = joinPath.mock.calls.map((call) => call[1])
      expect(joinedNames).toContain('README.md')
      expect(joinedNames).not.toContain('node_modules')
    } finally {
      joinPath.mockRestore()
    }
  })
})

describe('Explorer 慢目录归因', () => {
  it('超大目录分别记 list 墙钟、process 墙钟与同步排序相位', async () => {
    _resetPerfPhasesForTests()
    const root = URI.file('/ws')
    const entries = Array.from({ length: 10_001 }, (_, i) => file(`f${i}.ts`))
    const fs = makeFs({ [root.toString()]: entries })
    const inst = disposables.add(makeInst(fs, new FakeWorkspaceService(root), new FakeWatcher()))
    disposables.add(inst.createInstance(ExplorerTreeService))
    // 分片路径在 chunk 之间 yield（宏任务），多等几拍让整段处理跑完。
    for (let i = 0; i < 5; i++) await flush()

    const names = getRecordedPhases().map((p) => p.name)
    expect(names).toContain('explorer.listReadWall (expand, ipc, not cpu)')
    expect(names).toContain('explorer.processWall (expand, awaits, not cpu)')
    expect(names).toContain('explorer.sortEntries (expand, sync)')
    _resetPerfPhasesForTests()
  })
})
