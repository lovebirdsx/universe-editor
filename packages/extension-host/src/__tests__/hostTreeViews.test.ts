import { describe, expect, it, vi } from 'vitest'
import type { IMainThreadTreeViews } from '@universe-editor/extensions-common'
import type { TreeDataProvider, TreeView } from '@universe-editor/extension-api'
import { TreeItem, TreeItemCollapsibleState, Uri } from '@universe-editor/extension-api'
import { HostTreeViewRegistry } from '../hostTreeViews.js'

function fakeMainThread() {
  return {
    $registerTreeDataProvider: vi.fn(() => Promise.resolve()),
    $unregisterTreeDataProvider: vi.fn(() => Promise.resolve()),
    $refresh: vi.fn(() => Promise.resolve()),
  } satisfies IMainThreadTreeViews
}

interface TestElement {
  readonly name: string
  readonly children?: readonly TestElement[]
}

function fakeProvider(
  roots: readonly TestElement[],
  overrides: Partial<TreeDataProvider<TestElement>> = {},
): TreeDataProvider<TestElement> {
  return {
    getTreeItem: (element) =>
      new TreeItem(
        element.name,
        element.children !== undefined
          ? TreeItemCollapsibleState.Collapsed
          : TreeItemCollapsibleState.None,
      ),
    getChildren: (element): TestElement[] =>
      element === undefined ? [...roots] : [...(element.children ?? [])],
    ...overrides,
  }
}

const VIEW_ID = 'test.tree'

describe('HostTreeViewRegistry', () => {
  it('forwards registrations and rejects a duplicate view id', () => {
    const mainThread = fakeMainThread()
    const registry = new HostTreeViewRegistry(mainThread)

    registry.registerTreeDataProvider(VIEW_ID, fakeProvider([]))
    expect(mainThread.$registerTreeDataProvider).toHaveBeenCalledWith(VIEW_ID)
    expect(() => registry.registerTreeDataProvider(VIEW_ID, fakeProvider([]))).toThrow(
      /already registered/,
    )
  })

  it('serializes children with incrementing handles and full DTO fields', async () => {
    const mainThread = fakeMainThread()
    const registry = new HostTreeViewRegistry(mainThread)
    const resource = Uri.file('/repo/a.ts')
    registry.registerTreeDataProvider(
      VIEW_ID,
      fakeProvider([{ name: 'root-a' }, { name: 'root-b', children: [{ name: 'child' }] }], {
        getTreeItem: (element) => {
          const item = new TreeItem(
            { label: `label:${element.name}` },
            element.children !== undefined
              ? TreeItemCollapsibleState.Collapsed
              : TreeItemCollapsibleState.None,
          )
          if (element.name === 'root-a') {
            item.description = 'desc'
            item.tooltip = 'tip'
            item.contextValue = 'ctx'
            item.iconPath = 'git-commit'
            item.resourceUri = resource
            item.command = { command: 'test.open', title: 'Open', arguments: ['x'] }
          }
          return item
        },
      }),
    )

    const dtos = await registry.getChildren(VIEW_ID)
    expect(dtos).toHaveLength(2)
    expect(dtos[0]).toMatchObject({
      handle: 1,
      label: 'label:root-a',
      collapsibleState: 0,
      description: 'desc',
      tooltip: 'tip',
      contextValue: 'ctx',
      iconId: 'git-commit',
      resourceUri: resource.toJSON(),
      command: { command: 'test.open', title: 'Open', arguments: ['x'] },
    })
    expect(dtos[1]).toMatchObject({ handle: 2, label: 'label:root-b', collapsibleState: 1 })
  })

  it('resolves children of a parent via its handle and reuses element handles', async () => {
    const mainThread = fakeMainThread()
    const registry = new HostTreeViewRegistry(mainThread)
    const parent: TestElement = { name: 'parent', children: [{ name: 'child' }] }
    registry.registerTreeDataProvider(VIEW_ID, fakeProvider([parent]))

    const [rootDto] = await registry.getChildren(VIEW_ID)
    expect(rootDto).toBeDefined()
    const childDtos = await registry.getChildren(VIEW_ID, rootDto!.handle)
    expect(childDtos.map((d) => d.label)).toEqual(['child'])

    // Re-pulling the roots hands the same element the same handle.
    const rootsAgain = await registry.getChildren(VIEW_ID)
    expect(rootsAgain[0]!.handle).toBe(rootDto!.handle)
  })

  it('onDidChangeTreeData refreshes the view and invalidates every handle', async () => {
    const mainThread = fakeMainThread()
    const registry = new HostTreeViewRegistry(mainThread)
    let fireChange: (() => void) | undefined
    registry.registerTreeDataProvider(
      VIEW_ID,
      fakeProvider([{ name: 'root' }], {
        onDidChangeTreeData: (listener) => {
          fireChange = () => listener(undefined)
          return { dispose: () => (fireChange = undefined) }
        },
      }),
    )

    const [rootDto] = await registry.getChildren(VIEW_ID)
    fireChange?.()
    expect(mainThread.$refresh).toHaveBeenCalledWith(VIEW_ID)

    // The pre-refresh handle is stale: an empty page, not an error.
    await expect(registry.getChildren(VIEW_ID, rootDto!.handle)).resolves.toEqual([])
    // Re-pulled roots get fresh handles starting a new generation.
    const repulled = await registry.getChildren(VIEW_ID)
    expect(repulled[0]!.label).toBe('root')
  })

  it('unregisters on dispose; getChildren on an unknown view answers empty', async () => {
    const mainThread = fakeMainThread()
    const registry = new HostTreeViewRegistry(mainThread)

    const d = registry.registerTreeDataProvider(VIEW_ID, fakeProvider([{ name: 'root' }]))
    d.dispose()
    d.dispose()
    expect(mainThread.$unregisterTreeDataProvider).toHaveBeenCalledTimes(1)
    expect(mainThread.$unregisterTreeDataProvider).toHaveBeenCalledWith(VIEW_ID)
    await expect(registry.getChildren(VIEW_ID)).resolves.toEqual([])
  })

  it('treats a null parentHandle as the roots (JSON wire turns undefined into null)', async () => {
    const mainThread = fakeMainThread()
    const registry = new HostTreeViewRegistry(mainThread)
    registry.registerTreeDataProvider(VIEW_ID, fakeProvider([{ name: 'root' }]))

    const dtos = await registry.getChildren(VIEW_ID, null as unknown as undefined)
    expect(dtos.map((d) => d.label)).toEqual(['root'])
  })

  it('createTreeView facade mirrors visibility, selection and expansion', async () => {
    const mainThread = fakeMainThread()
    const registry = new HostTreeViewRegistry(mainThread)
    const parent: TestElement = { name: 'parent', children: [{ name: 'child' }] }
    const view = registry.createTreeView(VIEW_ID, {
      treeDataProvider: fakeProvider([parent]),
    }) as TreeView<TestElement>

    const visibilityEvents: boolean[] = []
    view.onDidChangeVisibility((e) => visibilityEvents.push(e.visible))
    registry.acceptVisibility(VIEW_ID, true)
    registry.acceptVisibility(VIEW_ID, true)
    expect(view.visible).toBe(true)
    expect(visibilityEvents).toEqual([true])

    const [rootDto] = await registry.getChildren(VIEW_ID)
    const selections: string[][] = []
    view.onDidChangeSelection((e) =>
      selections.push(e.selection.map((el) => (el as TestElement).name)),
    )
    registry.acceptSelection(VIEW_ID, [rootDto!.handle, 999])
    expect(selections).toEqual([['parent']])
    expect(view.selection).toEqual([parent])

    const expanded: string[] = []
    const collapsed: string[] = []
    view.onDidExpandElement((e) => expanded.push((e.element as TestElement).name))
    view.onDidCollapseElement((e) => collapsed.push((e.element as TestElement).name))
    registry.acceptExpansionState(VIEW_ID, rootDto!.handle, true)
    registry.acceptExpansionState(VIEW_ID, rootDto!.handle, false)
    registry.acceptExpansionState(VIEW_ID, 999, true)
    expect(expanded).toEqual(['parent'])
    expect(collapsed).toEqual(['parent'])

    view.dispose()
    expect(mainThread.$unregisterTreeDataProvider).toHaveBeenCalledWith(VIEW_ID)
  })

  it('dispose unregisters every view', () => {
    const mainThread = fakeMainThread()
    const registry = new HostTreeViewRegistry(mainThread)
    registry.registerTreeDataProvider('a', fakeProvider([]))
    registry.registerTreeDataProvider('b', fakeProvider([]))

    registry.dispose()
    expect(mainThread.$unregisterTreeDataProvider).toHaveBeenCalledWith('a')
    expect(mainThread.$unregisterTreeDataProvider).toHaveBeenCalledWith('b')
  })
})
