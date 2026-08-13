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
      // `arguments` deliberately do NOT ride the wire — they stay host-side
      // so a live object survives intact through $executeTreeItemCommand.
      command: { command: 'test.open', title: 'Open' },
    })
    expect(dtos[0]!.command).not.toHaveProperty('arguments')
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

  describe('executeTreeItemCommand', () => {
    function fakeExecute() {
      return vi.fn((_command: string, _args: unknown[]) => Promise.resolve(undefined))
    }

    it('runs the row click command with its original arguments, identical by reference', async () => {
      const mainThread = fakeMainThread()
      const execute = fakeExecute()
      const registry = new HostTreeViewRegistry(mainThread, execute)
      const resource = Uri.file('/repo/a.ts')
      const payload = { kind: 'row' }
      const args: unknown[] = [resource, payload]
      registry.registerTreeDataProvider(
        VIEW_ID,
        fakeProvider([{ name: 'root' }], {
          getTreeItem: (element) => {
            const item = new TreeItem(element.name, TreeItemCollapsibleState.None)
            item.command = { command: 'test.open', title: 'Open', arguments: args }
            return item
          },
        }),
      )

      const [dto] = await registry.getChildren(VIEW_ID)
      // vscode contract: the handler receives the arguments object the
      // extension itself returned — not the wire-flattened copy.
      await registry.executeTreeItemCommand(VIEW_ID, dto!.handle)
      expect(execute).toHaveBeenCalledTimes(1)
      const [id, passedArgs] = execute.mock.calls[0]!
      expect(id).toBe('test.open')
      expect(passedArgs).toBe(args)
      expect(passedArgs![0]).toBe(resource)
      expect(passedArgs![1]).toBe(payload)
    })

    it('falls back to the tree element when the row command declares no arguments', async () => {
      const mainThread = fakeMainThread()
      const execute = fakeExecute()
      const registry = new HostTreeViewRegistry(mainThread, execute)
      const element: TestElement = { name: 'root' }
      registry.registerTreeDataProvider(
        VIEW_ID,
        fakeProvider([element], {
          getTreeItem: (el) => {
            const item = new TreeItem(el.name, TreeItemCollapsibleState.None)
            item.command = { command: 'test.open', title: 'Open' }
            return item
          },
        }),
      )

      const [dto] = await registry.getChildren(VIEW_ID)
      await registry.executeTreeItemCommand(VIEW_ID, dto!.handle)
      expect(execute).toHaveBeenCalledWith('test.open', [element])
      expect(execute.mock.calls[0]![1]![0]).toBe(element)
    })

    it('runs a view/item/context menu command with the tree element as argument', async () => {
      const mainThread = fakeMainThread()
      const execute = fakeExecute()
      const registry = new HostTreeViewRegistry(mainThread, execute)
      const element: TestElement = { name: 'root' }
      registry.registerTreeDataProvider(VIEW_ID, fakeProvider([element]))

      const [dto] = await registry.getChildren(VIEW_ID)
      await registry.executeTreeItemCommand(VIEW_ID, dto!.handle, 'test.rowAction')
      expect(execute).toHaveBeenCalledTimes(1)
      expect(execute).toHaveBeenCalledWith('test.rowAction', [element])
      expect(execute.mock.calls[0]![1]![0]).toBe(element)
    })

    it('treats a null commandId as a row click (JSON wire turns undefined into null)', async () => {
      const mainThread = fakeMainThread()
      const execute = fakeExecute()
      const registry = new HostTreeViewRegistry(mainThread, execute)
      const element: TestElement = { name: 'root' }
      registry.registerTreeDataProvider(
        VIEW_ID,
        fakeProvider([element], {
          getTreeItem: (el) => {
            const item = new TreeItem(el.name, TreeItemCollapsibleState.None)
            item.command = { command: 'test.open', title: 'Open' }
            return item
          },
        }),
      )

      const [dto] = await registry.getChildren(VIEW_ID)
      await registry.executeTreeItemCommand(VIEW_ID, dto!.handle, null as unknown as string)
      expect(execute).toHaveBeenCalledWith('test.open', [element])
    })

    it('ignores stale handles, disabled commands and rows without a command', async () => {
      const mainThread = fakeMainThread()
      const execute = fakeExecute()
      const registry = new HostTreeViewRegistry(mainThread, execute)
      let fireChange: (() => void) | undefined
      registry.registerTreeDataProvider(
        VIEW_ID,
        fakeProvider([{ name: 'with-cmd' }, { name: 'disabled' }, { name: 'no-cmd' }], {
          onDidChangeTreeData: (listener) => {
            fireChange = () => listener(undefined)
            return { dispose: () => {} }
          },
          getTreeItem: (element) => {
            const item = new TreeItem(element.name, TreeItemCollapsibleState.None)
            if (element.name === 'with-cmd') {
              item.command = { command: 'test.open', title: 'Open' }
            } else if (element.name === 'disabled') {
              item.command = { command: 'test.open', title: 'Open', disabled: true }
            }
            return item
          },
        }),
      )

      const dtos = await registry.getChildren(VIEW_ID)
      // Row without a TreeItem.command: clicking it is a select-only action.
      await registry.executeTreeItemCommand(VIEW_ID, dtos[2]!.handle)
      // Disabled row command never runs.
      await registry.executeTreeItemCommand(VIEW_ID, dtos[1]!.handle)
      // Unknown view is a no-op.
      await registry.executeTreeItemCommand('unknown.view', 1, 'test.rowAction')
      expect(execute).not.toHaveBeenCalled()

      // After a refresh the handle table is rebuilt; an old handle resolves to
      // nothing and must not execute anything.
      fireChange?.()
      await registry.executeTreeItemCommand(VIEW_ID, dtos[0]!.handle)
      await registry.executeTreeItemCommand(VIEW_ID, dtos[0]!.handle, 'test.rowAction')
      expect(execute).not.toHaveBeenCalled()
    })
  })
})
