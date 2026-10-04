import { afterEach, describe, expect, it } from 'vitest'
import { DisposableStore, URI, type IDirectoryEntry } from '@universe-editor/platform'
import { ExplorerTreeService } from '../ExplorerTreeService.js'
import {
  FakeWatcher,
  FakeWorkspaceService,
  flush,
  makeFs,
  makeInst,
} from './explorerTreeTestHarness.js'

const directory = (name: string): IDirectoryEntry => ({ name, isDirectory: true, isFile: false })
const file = (name: string): IDirectoryEntry => ({ name, isDirectory: false, isFile: true })

const disposables = new DisposableStore()
afterEach(() => disposables.clear())

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
