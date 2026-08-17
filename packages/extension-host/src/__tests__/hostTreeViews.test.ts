import { describe, expect, it, vi } from 'vitest'
import type { IMainThreadTreeViews, ITreeItemDto } from '@universe-editor/extensions-common'
import type { TreeDataProvider, TreeView } from '@universe-editor/extension-api'
import { TreeItem, TreeItemCollapsibleState, Uri } from '@universe-editor/extension-api'
import { HostTreeViewRegistry } from '../hostTreeViews.js'

function fakeMainThread() {
  return {
    $registerTreeDataProvider: vi.fn(() => Promise.resolve()),
    $unregisterTreeDataProvider: vi.fn(() => Promise.resolve()),
    $refresh: vi.fn((_viewId: string, _items?: ITreeItemDto[]) => Promise.resolve()),
  } satisfies IMainThreadTreeViews
}

/** Debounce window used by the tests; kept tiny so waits stay cheap. */
const DEBOUNCE = 5

function waitForRefresh(mainThread: ReturnType<typeof fakeMainThread>, calls = 1): Promise<void> {
  return vi.waitFor(() => expect(mainThread.$refresh).toHaveBeenCalledTimes(calls))
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
    const sentResourceUri = dtos[0]!.resourceUri as unknown as { toJSON(): unknown }
    expect(sentResourceUri.toJSON()).toEqual({
      ...resource.toJSON(),
      $mid: 1,
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

  it('onDidChangeTreeData() with no element sends a whole-view refresh and keeps handles', async () => {
    const mainThread = fakeMainThread()
    const registry = new HostTreeViewRegistry(mainThread, undefined, DEBOUNCE)
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
    await waitForRefresh(mainThread)
    expect(mainThread.$refresh).toHaveBeenCalledWith(VIEW_ID)

    // Handles are stable: the pre-refresh handle still resolves, and the
    // re-pulled root comes back under the very same handle (which is what
    // keeps the renderer's expansion state alive across a refresh).
    await expect(registry.getChildren(VIEW_ID, rootDto!.handle)).resolves.toEqual([])
    const repulled = await registry.getChildren(VIEW_ID)
    expect(repulled[0]).toMatchObject({ handle: rootDto!.handle, label: 'root' })
  })

  it('debounces a burst of fires into a single wire refresh', async () => {
    const mainThread = fakeMainThread()
    const registry = new HostTreeViewRegistry(mainThread, undefined, DEBOUNCE)
    let fireChange: (() => void) | undefined
    registry.registerTreeDataProvider(
      VIEW_ID,
      fakeProvider([{ name: 'root' }], {
        onDidChangeTreeData: (listener) => {
          fireChange = () => listener(undefined)
          return { dispose: () => {} }
        },
      }),
    )
    await registry.getChildren(VIEW_ID)

    for (let i = 0; i < 20; i++) fireChange?.()
    await waitForRefresh(mainThread)
    // Give the window a chance to fire a second time if it were not merged.
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE * 4))
    expect(mainThread.$refresh).toHaveBeenCalledTimes(1)
  })

  it('onDidChangeTreeData(element) narrows the refresh to that subtree', async () => {
    const mainThread = fakeMainThread()
    const registry = new HostTreeViewRegistry(mainThread, undefined, DEBOUNCE)
    const parent: TestElement = { name: 'parent', children: [{ name: 'child' }] }
    let renamed = false
    let fireChange: ((element?: TestElement) => void) | undefined
    registry.registerTreeDataProvider(VIEW_ID, {
      onDidChangeTreeData: (listener) => {
        fireChange = (element) => listener(element)
        return { dispose: () => {} }
      },
      getChildren: (element) =>
        element === undefined ? [parent, { name: 'sibling' }] : [...(element.children ?? [])],
      getTreeItem: (element) =>
        new TreeItem(
          element === parent && renamed ? 'parent-renamed' : element.name,
          element.children !== undefined
            ? TreeItemCollapsibleState.Collapsed
            : TreeItemCollapsibleState.None,
        ),
    } satisfies TreeDataProvider<TestElement>)

    const roots = await registry.getChildren(VIEW_ID)
    const parentHandle = roots[0]!.handle

    renamed = true
    fireChange?.(parent)
    await waitForRefresh(mainThread)
    const [viewId, items] = mainThread.$refresh.mock.calls[0]!
    expect(viewId).toBe(VIEW_ID)
    // The refreshed item rides along under its stable handle, so the renderer
    // can swap the row in place instead of re-pulling the whole view.
    expect(items).toEqual([
      expect.objectContaining({ handle: parentHandle, label: 'parent-renamed' }),
    ])
  })

  it('merges a burst of element fires and dedupes repeats of the same element', async () => {
    const mainThread = fakeMainThread()
    const registry = new HostTreeViewRegistry(mainThread, undefined, DEBOUNCE)
    const a: TestElement = { name: 'a', children: [] }
    const b: TestElement = { name: 'b', children: [] }
    let fireChange: ((element?: TestElement | TestElement[]) => void) | undefined
    registry.registerTreeDataProvider(
      VIEW_ID,
      fakeProvider([a, b], {
        onDidChangeTreeData: (listener) => {
          fireChange = (element) => listener(element)
          return { dispose: () => {} }
        },
      }),
    )
    const roots = await registry.getChildren(VIEW_ID)

    fireChange?.(a)
    fireChange?.(a)
    fireChange?.(b)
    await waitForRefresh(mainThread)
    const items = mainThread.$refresh.mock.calls[0]![1]
    expect(items?.map((i) => i.handle)).toEqual([roots[0]!.handle, roots[1]!.handle])
  })

  it('a whole-view fire inside the window wins over the element fires it merged with', async () => {
    const mainThread = fakeMainThread()
    const registry = new HostTreeViewRegistry(mainThread, undefined, DEBOUNCE)
    const a: TestElement = { name: 'a', children: [] }
    let fireChange: ((element?: TestElement) => void) | undefined
    registry.registerTreeDataProvider(
      VIEW_ID,
      fakeProvider([a], {
        onDidChangeTreeData: (listener) => {
          fireChange = (element) => listener(element)
          return { dispose: () => {} }
        },
      }),
    )
    await registry.getChildren(VIEW_ID)

    fireChange?.(a)
    fireChange?.(undefined)
    await waitForRefresh(mainThread)
    expect(mainThread.$refresh).toHaveBeenCalledWith(VIEW_ID)
  })

  it('drops an element fire for a row the renderer never saw', async () => {
    const mainThread = fakeMainThread()
    const registry = new HostTreeViewRegistry(mainThread, undefined, DEBOUNCE)
    const unseen: TestElement = { name: 'never-serialized' }
    let fireChange: ((element?: TestElement) => void) | undefined
    registry.registerTreeDataProvider(
      VIEW_ID,
      fakeProvider([{ name: 'root' }], {
        onDidChangeTreeData: (listener) => {
          fireChange = (element) => listener(element)
          return { dispose: () => {} }
        },
      }),
    )
    await registry.getChildren(VIEW_ID)

    fireChange?.(unseen)
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE * 4))
    expect(mainThread.$refresh).not.toHaveBeenCalled()
  })

  it('keeps handles stable when the provider rebuilds its element objects', async () => {
    const mainThread = fakeMainThread()
    const registry = new HostTreeViewRegistry(mainThread, undefined, DEBOUNCE)
    // The common provider shape: fresh objects on every getChildren call.
    let generation = 0
    registry.registerTreeDataProvider(VIEW_ID, {
      getChildren: (element) => {
        generation++
        if (element === undefined) return [{ name: 'parent', children: [] }, { name: 'leaf' }]
        return element.name === 'parent' ? [{ name: 'child' }] : []
      },
      getTreeItem: (element) =>
        new TreeItem(
          element.name,
          element.name === 'parent'
            ? TreeItemCollapsibleState.Collapsed
            : TreeItemCollapsibleState.None,
        ),
    } satisfies TreeDataProvider<TestElement>)

    const first = await registry.getChildren(VIEW_ID)
    const childFirst = await registry.getChildren(VIEW_ID, first[0]!.handle)
    const second = await registry.getChildren(VIEW_ID)
    const childSecond = await registry.getChildren(VIEW_ID, second[0]!.handle)
    expect(second.map((d) => d.handle)).toEqual(first.map((d) => d.handle))
    expect(childSecond.map((d) => d.handle)).toEqual(childFirst.map((d) => d.handle))
    expect(generation).toBeGreaterThan(2)
  })

  it('prefers TreeItem.id over the label path for handle identity', async () => {
    const mainThread = fakeMainThread()
    const registry = new HostTreeViewRegistry(mainThread, undefined, DEBOUNCE)
    let label = 'before'
    registry.registerTreeDataProvider(VIEW_ID, {
      getChildren: (element) => (element === undefined ? [{ name: 'only' }] : []),
      getTreeItem: () => {
        const item = new TreeItem(label, TreeItemCollapsibleState.None)
        item.id = 'stable-id'
        return item
      },
    } satisfies TreeDataProvider<TestElement>)

    const [first] = await registry.getChildren(VIEW_ID)
    label = 'after'
    const [second] = await registry.getChildren(VIEW_ID)
    expect(second!.label).toBe('after')
    expect(second!.handle).toBe(first!.handle)
  })

  it('keeps the handle of a stable element whose label changed (rename)', async () => {
    const mainThread = fakeMainThread()
    const registry = new HostTreeViewRegistry(mainThread, undefined, DEBOUNCE)
    const parent: TestElement = { name: 'parent', children: [{ name: 'child' }] }
    let renamed = false
    registry.registerTreeDataProvider(VIEW_ID, {
      getChildren: (element) => (element === undefined ? [parent] : [...(element.children ?? [])]),
      getTreeItem: (element) =>
        new TreeItem(
          element === parent && renamed ? 'parent (renamed)' : element.name,
          element.children !== undefined
            ? TreeItemCollapsibleState.Collapsed
            : TreeItemCollapsibleState.None,
        ),
    } satisfies TreeDataProvider<TestElement>)

    const [before] = await registry.getChildren(VIEW_ID)
    const [childBefore] = await registry.getChildren(VIEW_ID, before!.handle)

    // Without a TreeItem.id the label is the weakest identity — but the
    // provider handed back the same element object, so the row (and with it
    // the renderer's expansion state) must keep its handle.
    renamed = true
    const [after] = await registry.getChildren(VIEW_ID)
    expect(after!.label).toBe('parent (renamed)')
    expect(after!.handle).toBe(before!.handle)
    // Children key off the parent handle, not its label, so they are untouched.
    const [childAfter] = await registry.getChildren(VIEW_ID, after!.handle)
    expect(childAfter!.handle).toBe(childBefore!.handle)
  })

  it('gives same-labelled siblings distinct, position-stable handles', async () => {
    const mainThread = fakeMainThread()
    const registry = new HostTreeViewRegistry(mainThread, undefined, DEBOUNCE)
    registry.registerTreeDataProvider(
      VIEW_ID,
      fakeProvider([{ name: 'dup' }, { name: 'dup' }, { name: 'other' }]),
    )

    const first = await registry.getChildren(VIEW_ID)
    expect(new Set(first.map((d) => d.handle)).size).toBe(3)
    const second = await registry.getChildren(VIEW_ID)
    expect(second.map((d) => d.handle)).toEqual(first.map((d) => d.handle))
  })

  it('recycles the handle of a row (and its subtree) that left the tree', async () => {
    const mainThread = fakeMainThread()
    const registry = new HostTreeViewRegistry(mainThread, undefined, DEBOUNCE)
    let roots: TestElement[] = [{ name: 'gone', children: [{ name: 'child' }] }, { name: 'stays' }]
    registry.registerTreeDataProvider(VIEW_ID, {
      getChildren: (element) => (element === undefined ? roots : [...(element.children ?? [])]),
      getTreeItem: (element) =>
        new TreeItem(
          element.name,
          element.children !== undefined
            ? TreeItemCollapsibleState.Collapsed
            : TreeItemCollapsibleState.None,
        ),
    } satisfies TreeDataProvider<TestElement>)

    const first = await registry.getChildren(VIEW_ID)
    const goneHandle = first[0]!.handle
    const staysHandle = first[1]!.handle
    const [childDto] = await registry.getChildren(VIEW_ID, goneHandle)

    roots = [{ name: 'stays' }]
    const second = await registry.getChildren(VIEW_ID)
    expect(second.map((d) => d.handle)).toEqual([staysHandle])
    // Both the removed row and its cached subtree stop resolving.
    await expect(registry.getChildren(VIEW_ID, goneHandle)).resolves.toEqual([])
    await expect(registry.getChildren(VIEW_ID, childDto!.handle)).resolves.toEqual([])
  })

  it('resolves getTreeItem for a page in parallel, not one child at a time', async () => {
    const mainThread = fakeMainThread()
    const registry = new HostTreeViewRegistry(mainThread, undefined, DEBOUNCE)
    let inFlight = 0
    let peak = 0
    registry.registerTreeDataProvider(VIEW_ID, {
      getChildren: (element) =>
        element === undefined
          ? Array.from({ length: 20 }, (_, i) => ({ name: `n${i}` }))
          : ([] as TestElement[]),
      getTreeItem: async (element) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await Promise.resolve()
        inFlight--
        return new TreeItem(element.name, TreeItemCollapsibleState.None)
      },
    } satisfies TreeDataProvider<TestElement>)

    await registry.getChildren(VIEW_ID)
    expect(peak).toBe(20)
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

  it('treats an explicitly-cast null parentHandle the same as an omitted one (the roots)', async () => {
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

    it('treats an explicitly-cast null commandId the same as a row click', async () => {
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

    it('ignores recycled handles, disabled commands and rows without a command', async () => {
      const mainThread = fakeMainThread()
      const execute = fakeExecute()
      const registry = new HostTreeViewRegistry(mainThread, execute, DEBOUNCE)
      let roots: TestElement[] = [{ name: 'with-cmd' }, { name: 'disabled' }, { name: 'no-cmd' }]
      registry.registerTreeDataProvider(VIEW_ID, {
        getChildren: (element) => (element === undefined ? roots : []),
        getTreeItem: (element) => {
          const item = new TreeItem(element.name, TreeItemCollapsibleState.None)
          if (element.name === 'with-cmd') {
            item.command = { command: 'test.open', title: 'Open' }
          } else if (element.name === 'disabled') {
            item.command = { command: 'test.open', title: 'Open', disabled: true }
          }
          return item
        },
      } satisfies TreeDataProvider<TestElement>)

      const dtos = await registry.getChildren(VIEW_ID)
      // Row without a TreeItem.command: clicking it is a select-only action.
      await registry.executeTreeItemCommand(VIEW_ID, dtos[2]!.handle)
      // Disabled row command never runs.
      await registry.executeTreeItemCommand(VIEW_ID, dtos[1]!.handle)
      // Unknown view is a no-op.
      await registry.executeTreeItemCommand('unknown.view', 1, 'test.rowAction')
      expect(execute).not.toHaveBeenCalled()

      // The row leaves the tree: its handle is recycled on the next pull and
      // must not execute anything afterwards.
      roots = [{ name: 'disabled' }, { name: 'no-cmd' }]
      await registry.getChildren(VIEW_ID)
      await registry.executeTreeItemCommand(VIEW_ID, dtos[0]!.handle)
      await registry.executeTreeItemCommand(VIEW_ID, dtos[0]!.handle, 'test.rowAction')
      expect(execute).not.toHaveBeenCalled()
    })
  })
})
