import { describe, expect, it, vi } from 'vitest'
import type { IExtHostTreeViews, ITreeItemDto } from '@universe-editor/extensions-common'
import { TreeViewsService } from '../TreeViewsService.js'

const VIEW_ID = 'test.tree'

function dto(handle: number, label: string, collapsibleState: 0 | 1 | 2 = 0): ITreeItemDto {
  return { handle, label, collapsibleState }
}

function fakeExtHost(childrenByParent: Record<string, ITreeItemDto[]>) {
  return {
    $getChildren: vi.fn((viewId: string, parentHandle?: number) =>
      Promise.resolve(childrenByParent[String(parentHandle ?? 'root')] ?? []),
    ),
    $acceptTreeViewVisibility: vi.fn(() => Promise.resolve()),
    $acceptSelection: vi.fn(() => Promise.resolve()),
    $acceptExpansionState: vi.fn(() => Promise.resolve()),
    $executeTreeItemCommand: vi.fn(() => Promise.resolve()),
  } satisfies IExtHostTreeViews
}

describe('TreeViewsService', () => {
  it('registers/unregisters providers and fires onDidChangeView', async () => {
    const service = new TreeViewsService()
    const events: string[] = []
    service.onDidChangeView((viewId) => events.push(viewId))

    expect(service.hasProvider(VIEW_ID)).toBe(false)
    await service.$registerTreeDataProvider(VIEW_ID)
    expect(service.hasProvider(VIEW_ID)).toBe(true)
    await service.$unregisterTreeDataProvider(VIEW_ID)
    expect(service.hasProvider(VIEW_ID)).toBe(false)
    expect(events).toEqual([VIEW_ID, VIEW_ID])
  })

  it('pulls roots and children lazily through the ext host proxy', async () => {
    const service = new TreeViewsService()
    const extHost = fakeExtHost({
      root: [dto(1, 'root-a'), dto(2, 'root-b', 1)],
      '2': [dto(3, 'child')],
    })
    service.setExtHost(extHost)
    await service.$registerTreeDataProvider(VIEW_ID)

    expect(service.getRoots(VIEW_ID)).toBeNull()
    await service.loadChildren(VIEW_ID)
    expect(service.getRoots(VIEW_ID)?.map((d) => d.label)).toEqual(['root-a', 'root-b'])

    expect(service.getChildren(VIEW_ID, 2)).toBeNull()
    await service.loadChildren(VIEW_ID, 2)
    expect(service.getChildren(VIEW_ID, 2)?.map((d) => d.label)).toEqual(['child'])
    expect(extHost.$getChildren).toHaveBeenCalledTimes(2)
  })

  it('dedupes concurrent pulls for the same parent', async () => {
    const service = new TreeViewsService()
    const extHost = fakeExtHost({ root: [dto(1, 'root-a')] })
    service.setExtHost(extHost)
    await service.$registerTreeDataProvider(VIEW_ID)

    await Promise.all([service.loadChildren(VIEW_ID), service.loadChildren(VIEW_ID)])
    expect(extHost.$getChildren).toHaveBeenCalledTimes(1)
  })

  it('passes undefined straight through on a roots pull (the proxy strips it, never as null)', async () => {
    const service = new TreeViewsService()
    const extHost = fakeExtHost({ root: [dto(1, 'root-a')] })
    service.setExtHost(extHost)
    await service.$registerTreeDataProvider(VIEW_ID)

    await service.loadChildren(VIEW_ID)
    expect(extHost.$getChildren).toHaveBeenCalledTimes(1)
    expect(extHost.$getChildren).toHaveBeenCalledWith(VIEW_ID, undefined)
  })

  it('$refresh drops the cache and discards an in-flight pull from the dead epoch', async () => {
    const service = new TreeViewsService()
    let resolvePull: ((items: ITreeItemDto[]) => void) | undefined
    const extHost = fakeExtHost({ root: [dto(1, 'fresh')] })
    extHost.$getChildren.mockImplementationOnce(
      () => new Promise<ITreeItemDto[]>((resolve) => (resolvePull = resolve)),
    )
    service.setExtHost(extHost)
    await service.$registerTreeDataProvider(VIEW_ID)

    const stalePull = service.loadChildren(VIEW_ID)
    await service.$refresh(VIEW_ID)
    // The stale pull resolves after the refresh: its handles are dead.
    resolvePull?.([dto(99, 'stale')])
    await stalePull
    expect(service.getRoots(VIEW_ID)).toBeNull()

    await service.loadChildren(VIEW_ID)
    expect(service.getRoots(VIEW_ID)?.map((d) => d.label)).toEqual(['fresh'])
  })

  it('re-pulls on retry when a $refresh lands during an in-flight roots pull', async () => {
    const service = new TreeViewsService()
    let resolveStale: ((items: ITreeItemDto[]) => void) | undefined
    const extHost = fakeExtHost({ root: [dto(1, 'fresh')] })
    extHost.$getChildren.mockImplementationOnce(
      () => new Promise<ITreeItemDto[]>((resolve) => (resolveStale = resolve)),
    )
    service.setExtHost(extHost)
    await service.$registerTreeDataProvider(VIEW_ID)

    const stalePull = service.loadChildren(VIEW_ID)
    await service.$refresh(VIEW_ID)
    // What the view does on onDidChangeView (roots went back to null): retry.
    // The in-flight stale pull belongs to a dead epoch, so it must not dedupe
    // this retry — otherwise the stale settle is discarded and nothing ever
    // pulls again (permanently blank tree).
    const retryPull = service.loadChildren(VIEW_ID)
    expect(extHost.$getChildren).toHaveBeenCalledTimes(2)

    resolveStale?.([dto(99, 'stale')])
    await Promise.all([stalePull, retryPull])
    expect(service.getRoots(VIEW_ID)?.map((d) => d.label)).toEqual(['fresh'])
  })

  it('discards a stale pull that settles after the retry already landed', async () => {
    const service = new TreeViewsService()
    let resolveStale: ((items: ITreeItemDto[]) => void) | undefined
    const extHost = fakeExtHost({ root: [dto(1, 'fresh')] })
    extHost.$getChildren.mockImplementationOnce(
      () => new Promise<ITreeItemDto[]>((resolve) => (resolveStale = resolve)),
    )
    service.setExtHost(extHost)
    await service.$registerTreeDataProvider(VIEW_ID)

    const stalePull = service.loadChildren(VIEW_ID)
    await service.$refresh(VIEW_ID)
    // The retry settles first and clears the in-flight entry; the epoch must
    // stay put, or the still-pending stale pull compares equal again and
    // overwrites the fresh rows.
    await service.loadChildren(VIEW_ID)
    expect(service.getRoots(VIEW_ID)?.map((d) => d.label)).toEqual(['fresh'])

    resolveStale?.([dto(99, 'stale')])
    await stalePull
    expect(service.getRoots(VIEW_ID)?.map((d) => d.label)).toEqual(['fresh'])
  })

  it('$refresh with items invalidates only that subtree and keeps sibling pages', async () => {
    const service = new TreeViewsService()
    const extHost = fakeExtHost({
      root: [dto(1, 'a', 1), dto(2, 'b', 1)],
      '1': [dto(3, 'a-child')],
      '2': [dto(4, 'b-child')],
    })
    service.setExtHost(extHost)
    await service.$registerTreeDataProvider(VIEW_ID)
    await service.loadChildren(VIEW_ID)
    await service.loadChildren(VIEW_ID, 1)
    await service.loadChildren(VIEW_ID, 2)

    const events: string[] = []
    service.onDidChangeView((viewId) => events.push(viewId))
    await service.$refresh(VIEW_ID, [dto(1, 'a (renamed)', 1)])

    // The row itself is replaced in place — the roots page survives.
    expect(service.getRoots(VIEW_ID)?.map((d) => d.label)).toEqual(['a (renamed)', 'b'])
    // Only the refreshed node's children page went away.
    expect(service.getChildren(VIEW_ID, 1)).toBeNull()
    expect(service.getChildren(VIEW_ID, 2)?.map((d) => d.label)).toEqual(['b-child'])
    expect(events).toEqual([VIEW_ID])
  })

  it('$refresh with items drops the whole subtree below the changed node', async () => {
    const service = new TreeViewsService()
    const extHost = fakeExtHost({
      root: [dto(1, 'a', 1)],
      '1': [dto(2, 'a-child', 1)],
      '2': [dto(3, 'a-grandchild')],
    })
    service.setExtHost(extHost)
    await service.$registerTreeDataProvider(VIEW_ID)
    await service.loadChildren(VIEW_ID)
    await service.loadChildren(VIEW_ID, 1)
    await service.loadChildren(VIEW_ID, 2)

    await service.$refresh(VIEW_ID, [dto(1, 'a', 1)])
    expect(service.getChildren(VIEW_ID, 1)).toBeNull()
    expect(service.getChildren(VIEW_ID, 2)).toBeNull()
  })

  it('$refresh with an uncached handle changes nothing and fires no event', async () => {
    const service = new TreeViewsService()
    const extHost = fakeExtHost({ root: [dto(1, 'a')] })
    service.setExtHost(extHost)
    await service.$registerTreeDataProvider(VIEW_ID)
    await service.loadChildren(VIEW_ID)

    const events: string[] = []
    service.onDidChangeView((viewId) => events.push(viewId))
    await service.$refresh(VIEW_ID, [dto(42, 'never seen')])

    expect(service.getRoots(VIEW_ID)?.map((d) => d.label)).toEqual(['a'])
    expect(events).toEqual([])
  })

  it('$refresh with an empty items array keeps the whole-view semantics', async () => {
    const service = new TreeViewsService()
    const extHost = fakeExtHost({ root: [dto(1, 'a', 1)], '1': [dto(2, 'a-child')] })
    service.setExtHost(extHost)
    await service.$registerTreeDataProvider(VIEW_ID)
    await service.loadChildren(VIEW_ID)
    await service.loadChildren(VIEW_ID, 1)

    await service.$refresh(VIEW_ID, [])
    expect(service.getRoots(VIEW_ID)).toBeNull()
    expect(service.getChildren(VIEW_ID, 1)).toBeNull()
  })

  it('discards an in-flight subtree pull invalidated by a $refresh on that node', async () => {
    const service = new TreeViewsService()
    let resolveStale: ((items: ITreeItemDto[]) => void) | undefined
    const extHost = fakeExtHost({ root: [dto(1, 'a', 1)], '1': [dto(2, 'fresh')] })
    service.setExtHost(extHost)
    await service.$registerTreeDataProvider(VIEW_ID)
    await service.loadChildren(VIEW_ID)

    extHost.$getChildren.mockImplementationOnce(
      () => new Promise<ITreeItemDto[]>((resolve) => (resolveStale = resolve)),
    )
    const stalePull = service.loadChildren(VIEW_ID, 1)
    await service.$refresh(VIEW_ID, [dto(1, 'a', 1)])
    const retryPull = service.loadChildren(VIEW_ID, 1)

    resolveStale?.([dto(99, 'stale')])
    await Promise.all([stalePull, retryPull])
    expect(service.getChildren(VIEW_ID, 1)?.map((d) => d.label)).toEqual(['fresh'])
  })

  it('re-pulling a page drops the cache of rows that left it', async () => {
    const service = new TreeViewsService()
    const children: Record<string, ITreeItemDto[]> = {
      root: [dto(1, 'a', 1), dto(2, 'b', 1)],
      '1': [dto(3, 'a-child')],
      '2': [dto(4, 'b-child')],
    }
    const extHost = fakeExtHost(children)
    service.setExtHost(extHost)
    await service.$registerTreeDataProvider(VIEW_ID)
    await service.loadChildren(VIEW_ID)
    await service.loadChildren(VIEW_ID, 1)
    await service.loadChildren(VIEW_ID, 2)

    // `b` leaves the tree: re-pulling the roots page must take its cached
    // children page with it (no orphan pages behind a dead handle).
    children['root'] = [dto(1, 'a', 1)]
    await service.loadChildren(VIEW_ID)
    expect(service.getRoots(VIEW_ID)?.map((d) => d.label)).toEqual(['a'])
    expect(service.getChildren(VIEW_ID, 2)).toBeNull()
    expect(service.getChildren(VIEW_ID, 1)?.map((d) => d.label)).toEqual(['a-child'])
  })

  it('replays the last reported visibility when the provider re-registers after a host restart', async () => {
    const service = new TreeViewsService()
    const host1 = fakeExtHost({})
    service.setExtHost(host1)
    await service.$registerTreeDataProvider(VIEW_ID)
    service.setViewVisibility(VIEW_ID, true)
    expect(host1.$acceptTreeViewVisibility).toHaveBeenCalledTimes(1)

    // Host restart: teardown drops every model + the proxy while the view
    // stays mounted (it never re-pushes on its own).
    service.reset()
    const host2 = fakeExtHost({})
    service.setExtHost(host2)
    await service.$registerTreeDataProvider(VIEW_ID)
    expect(host2.$acceptTreeViewVisibility).toHaveBeenCalledTimes(1)
    expect(host2.$acceptTreeViewVisibility).toHaveBeenCalledWith(VIEW_ID, true)

    // The replay seeds the dedupe: re-pushing the same value is dropped.
    service.setViewVisibility(VIEW_ID, true)
    expect(host2.$acceptTreeViewVisibility).toHaveBeenCalledTimes(1)
  })

  it('replays a false visibility recorded before the restart', async () => {
    const service = new TreeViewsService()
    const host1 = fakeExtHost({})
    service.setExtHost(host1)
    await service.$registerTreeDataProvider(VIEW_ID)
    service.setViewVisibility(VIEW_ID, true)
    service.setViewVisibility(VIEW_ID, false)

    service.reset()
    const host2 = fakeExtHost({})
    service.setExtHost(host2)
    await service.$registerTreeDataProvider(VIEW_ID)
    expect(host2.$acceptTreeViewVisibility).toHaveBeenCalledTimes(1)
    expect(host2.$acceptTreeViewVisibility).toHaveBeenCalledWith(VIEW_ID, false)
  })

  it('routes tree item command execution through the ext host, with undefined for a row click', async () => {
    const service = new TreeViewsService()
    const extHost = fakeExtHost({})
    service.setExtHost(extHost)
    await service.$registerTreeDataProvider(VIEW_ID)

    service.executeTreeItemCommand(VIEW_ID, 1)
    expect(extHost.$executeTreeItemCommand).toHaveBeenCalledTimes(1)
    // The host tells the entry points apart by an absent vs present commandId;
    // the RPC proxy strips a trailing undefined so it round-trips as absent.
    expect(extHost.$executeTreeItemCommand).toHaveBeenCalledWith(VIEW_ID, 1, undefined)

    service.executeTreeItemCommand(VIEW_ID, 2, 'test.rowAction')
    expect(extHost.$executeTreeItemCommand).toHaveBeenNthCalledWith(2, VIEW_ID, 2, 'test.rowAction')
  })

  it('routes tree item command execution nowhere without a provider or ext host', async () => {
    const service = new TreeViewsService()
    const extHost = fakeExtHost({})
    service.executeTreeItemCommand(VIEW_ID, 1)
    service.executeTreeItemCommand(VIEW_ID, 1, 'test.rowAction')
    service.setExtHost(extHost)
    service.executeTreeItemCommand(VIEW_ID, 1)
    expect(extHost.$executeTreeItemCommand).not.toHaveBeenCalled()
  })

  it('loadChildren is a no-op without a provider or ext host', async () => {
    const service = new TreeViewsService()
    const extHost = fakeExtHost({})
    await service.loadChildren(VIEW_ID)
    service.setExtHost(extHost)
    await service.loadChildren(VIEW_ID)
    expect(extHost.$getChildren).not.toHaveBeenCalled()
  })

  it('forwards interaction callbacks and dedupes visibility', async () => {
    const service = new TreeViewsService()
    const extHost = fakeExtHost({})
    service.setExtHost(extHost)
    await service.$registerTreeDataProvider(VIEW_ID)

    service.setViewVisibility(VIEW_ID, true)
    service.setViewVisibility(VIEW_ID, true)
    service.setViewVisibility(VIEW_ID, false)
    expect(extHost.$acceptTreeViewVisibility).toHaveBeenCalledTimes(2)
    expect(extHost.$acceptTreeViewVisibility).toHaveBeenNthCalledWith(1, VIEW_ID, true)
    expect(extHost.$acceptTreeViewVisibility).toHaveBeenNthCalledWith(2, VIEW_ID, false)

    service.setSelection(VIEW_ID, [1, 2])
    expect(extHost.$acceptSelection).toHaveBeenCalledWith(VIEW_ID, [1, 2])
    service.setExpansionState(VIEW_ID, 1, true)
    expect(extHost.$acceptExpansionState).toHaveBeenCalledWith(VIEW_ID, 1, true)
  })

  it('reset drops every view and the ext host proxy', async () => {
    const service = new TreeViewsService()
    const extHost = fakeExtHost({ root: [dto(1, 'root-a')] })
    service.setExtHost(extHost)
    await service.$registerTreeDataProvider(VIEW_ID)
    await service.loadChildren(VIEW_ID)

    service.reset()
    expect(service.hasProvider(VIEW_ID)).toBe(false)
    expect(service.getRoots(VIEW_ID)).toBeNull()
    await service.loadChildren(VIEW_ID)
    expect(extHost.$getChildren).toHaveBeenCalledTimes(1)
  })
})
