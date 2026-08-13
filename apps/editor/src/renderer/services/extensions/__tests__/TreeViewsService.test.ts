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

  it('omits the parentHandle argument on a roots pull (undefined crosses as null)', async () => {
    const service = new TreeViewsService()
    const extHost = fakeExtHost({ root: [dto(1, 'root-a')] })
    service.setExtHost(extHost)
    await service.$registerTreeDataProvider(VIEW_ID)

    await service.loadChildren(VIEW_ID)
    expect(extHost.$getChildren).toHaveBeenCalledTimes(1)
    expect(extHost.$getChildren.mock.calls[0]).toHaveLength(1)
  })

  it('$refresh drops the cache and discards an in-flight pull from the dead generation', async () => {
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
    // The in-flight stale pull belongs to a dead generation, so it must not
    // dedupe this retry — otherwise the stale settle is discarded and nothing
    // ever pulls again (permanently blank tree).
    const retryPull = service.loadChildren(VIEW_ID)
    expect(extHost.$getChildren).toHaveBeenCalledTimes(2)

    resolveStale?.([dto(99, 'stale')])
    await Promise.all([stalePull, retryPull])
    expect(service.getRoots(VIEW_ID)?.map((d) => d.label)).toEqual(['fresh'])
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

  it('routes tree item command execution through the ext host, omitting an absent commandId', async () => {
    const service = new TreeViewsService()
    const extHost = fakeExtHost({})
    service.setExtHost(extHost)
    await service.$registerTreeDataProvider(VIEW_ID)

    service.executeTreeItemCommand(VIEW_ID, 1)
    expect(extHost.$executeTreeItemCommand).toHaveBeenCalledTimes(1)
    // A row click must not send an explicit third argument — undefined would
    // cross the newline-JSON wire as null. The host tells the entry points
    // apart by an omitted vs present commandId.
    expect(extHost.$executeTreeItemCommand.mock.calls[0]).toEqual([VIEW_ID, 1])

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
