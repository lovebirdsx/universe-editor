/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/extensionViews/ExtensionTreeView.tsx
 *
 *  Covers the rendered tree against a real TreeViewsService wired to a fake ext
 *  host: lazy children pulls on expand, interaction callbacks flowing back
 *  (selection / expansion), command execution routed host-side by handle
 *  (row click + `view/item/context` menu), and the menu scoped with
 *  view/viewItem keys.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  CommandsRegistry,
  ICommandService,
  IContextKeyService,
  InstantiationService,
  MenuId,
  MenuRegistry,
  ServiceCollection,
} from '@universe-editor/platform'
import type { IExtHostTreeViews, ITreeItemDto } from '@universe-editor/extensions-common'
import { ServicesContext } from '../../useService.js'
import {
  ITreeViewsService,
  TreeViewsService,
} from '../../../services/extensions/TreeViewsService.js'
import { ExtensionTreeView } from '../ExtensionTreeView.js'

const VIEW_ID = 'test.tree'

function dto(handle: number, label: string, overrides: Partial<ITreeItemDto> = {}): ITreeItemDto {
  return { handle, label, collapsibleState: 0, ...overrides }
}

function setup(childrenByParent: Record<string, ITreeItemDto[]>) {
  const treeViews = new TreeViewsService()
  const extHost = {
    $getChildren: vi.fn((viewId: string, parentHandle?: number) =>
      Promise.resolve(childrenByParent[String(parentHandle ?? 'root')] ?? []),
    ),
    $acceptTreeViewVisibility: vi.fn(() => Promise.resolve()),
    $acceptSelection: vi.fn(() => Promise.resolve()),
    $acceptExpansionState: vi.fn(() => Promise.resolve()),
    $executeTreeItemCommand: vi.fn(() => Promise.resolve()),
  } satisfies IExtHostTreeViews
  treeViews.setExtHost(extHost)

  const executeCommand = vi.fn()
  const createScoped = vi.fn(() => ({
    contextMatchesRules: () => true,
    dispose: vi.fn(),
  }))
  const services = new ServiceCollection()
  services.set(ITreeViewsService, treeViews)
  services.set(ICommandService, { _serviceBrand: undefined, executeCommand } as never)
  services.set(IContextKeyService, { _serviceBrand: undefined, createScoped } as never)
  return { treeViews, extHost, executeCommand, createScoped, services }
}

async function renderView(services: ServiceCollection): Promise<void> {
  const instantiation = new InstantiationService(services)
  render(
    <ServicesContext.Provider value={instantiation}>
      <ExtensionTreeView viewId={VIEW_ID} />
    </ServicesContext.Provider>,
  )
  await act(async () => {})
}

afterEach(() => cleanup())

describe('ExtensionTreeView', () => {
  it('shows the placeholder while no provider is registered', async () => {
    const { services } = setup({})
    await renderView(services)
    expect(screen.getByTestId('extension-tree-view').textContent).toContain('Loading')
  })

  it('renders pulled roots with label and description', async () => {
    const { treeViews, services } = setup({
      root: [
        dto(1, 'root-a', { description: 'desc-a' }),
        dto(2, 'root-b', { collapsibleState: 1 }),
      ],
    })
    await treeViews.$registerTreeDataProvider(VIEW_ID)
    await renderView(services)

    const rows = screen.getAllByTestId('extension-tree-item')
    expect(rows.map((r) => r.textContent)).toEqual(['root-adesc-a', 'root-b'])
    expect(rows[0]!.getAttribute('aria-expanded')).toBeNull()
    expect(rows[1]!.getAttribute('aria-expanded')).toBe('false')
  })

  it('expands a collapsed node by pulling its children and pushes expansion state', async () => {
    const { treeViews, extHost, services } = setup({
      root: [dto(2, 'root-b', { collapsibleState: 1 })],
      '2': [dto(3, 'child')],
    })
    await treeViews.$registerTreeDataProvider(VIEW_ID)
    await renderView(services)

    fireEvent.click(screen.getByText('root-b'))
    await act(async () => {})

    expect(extHost.$getChildren).toHaveBeenCalledWith(VIEW_ID, 2)
    expect(screen.getByText('child')).toBeTruthy()
    expect(extHost.$acceptExpansionState).toHaveBeenCalledWith(VIEW_ID, 2, true)
    expect(extHost.$acceptSelection).toHaveBeenCalledWith(VIEW_ID, [2])
  })

  it('runs the item command on click through the ext host, not the renderer command service', async () => {
    const { treeViews, extHost, executeCommand, services } = setup({
      root: [
        dto(1, 'root-a', {
          command: { command: 'test.open', title: 'Open' },
        }),
      ],
    })
    await treeViews.$registerTreeDataProvider(VIEW_ID)
    await renderView(services)

    // The command is resolved host-side against the handle: the extension
    // handler receives the original TreeItem.command arguments (live objects
    // like Uri), which must never round-trip through the renderer registry.
    fireEvent.click(screen.getByText('root-a'))
    expect(extHost.$executeTreeItemCommand).toHaveBeenCalledTimes(1)
    expect(extHost.$executeTreeItemCommand).toHaveBeenCalledWith(VIEW_ID, 1)
    expect(executeCommand).not.toHaveBeenCalled()
  })

  it('does not run a disabled item command', async () => {
    const { treeViews, extHost, services } = setup({
      root: [
        dto(1, 'root-a', {
          command: { command: 'test.open', title: 'Open', disabled: true },
        }),
      ],
    })
    await treeViews.$registerTreeDataProvider(VIEW_ID)
    await renderView(services)

    fireEvent.click(screen.getByText('root-a'))
    expect(extHost.$executeTreeItemCommand).not.toHaveBeenCalled()
  })

  it('opens the view/item/context menu on right-click with view/viewItem keys', async () => {
    const { treeViews, createScoped, services } = setup({
      root: [dto(1, 'root-a', { contextValue: 'myCtx' })],
    })
    await treeViews.$registerTreeDataProvider(VIEW_ID)
    const commandDisposable = CommandsRegistry.registerCommand({
      id: 'test.rowAction',
      handler: () => undefined,
    })
    const menuDisposable = MenuRegistry.addMenuItem(MenuId.ViewItemContext, {
      command: 'test.rowAction',
      title: 'Row Action',
    })
    try {
      await renderView(services)

      fireEvent.contextMenu(screen.getByText('root-a'))
      expect(createScoped).toHaveBeenCalledWith({ view: VIEW_ID, viewItem: 'myCtx' })
      expect(await screen.findByRole('menuitem', { name: 'Row Action' })).toBeTruthy()
    } finally {
      menuDisposable.dispose()
      commandDisposable.dispose()
    }
  })

  it('executes a view/item/context menu command through the ext host with the item handle', async () => {
    const { treeViews, extHost, executeCommand, services } = setup({
      root: [dto(1, 'root-a', { contextValue: 'myCtx' })],
    })
    await treeViews.$registerTreeDataProvider(VIEW_ID)
    const commandDisposable = CommandsRegistry.registerCommand({
      id: 'test.rowAction',
      handler: () => undefined,
    })
    const menuDisposable = MenuRegistry.addMenuItem(MenuId.ViewItemContext, {
      command: 'test.rowAction',
      title: 'Row Action',
    })
    try {
      await renderView(services)

      fireEvent.contextMenu(screen.getByText('root-a'))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Row Action' }))
      // vscode contract: the extension handler receives the tree element, so
      // the menu command is resolved host-side from the handle instead of
      // handing the renderer-side DTO to the local command service.
      expect(extHost.$executeTreeItemCommand).toHaveBeenCalledTimes(1)
      expect(extHost.$executeTreeItemCommand).toHaveBeenCalledWith(VIEW_ID, 1, 'test.rowAction')
      expect(executeCommand).not.toHaveBeenCalled()
    } finally {
      menuDisposable.dispose()
      commandDisposable.dispose()
    }
  })

  it('resets to the placeholder when the provider unregisters', async () => {
    const { treeViews, services } = setup({ root: [dto(1, 'root-a')] })
    await treeViews.$registerTreeDataProvider(VIEW_ID)
    await renderView(services)
    expect(screen.getByText('root-a')).toBeTruthy()

    await act(async () => {
      await treeViews.$unregisterTreeDataProvider(VIEW_ID)
    })
    expect(screen.queryByText('root-a')).toBeNull()
    expect(screen.getByTestId('extension-tree-view')).toBeTruthy()
  })

  it('re-pulls the roots when a $refresh lands during the initial pull', async () => {
    let resolveStale: ((items: ITreeItemDto[]) => void) | undefined
    const backing = { root: [dto(2, 'root-fresh')] }
    const { treeViews, extHost, services } = setup(backing)
    extHost.$getChildren.mockImplementationOnce(
      () => new Promise<ITreeItemDto[]>((resolve) => (resolveStale = resolve)),
    )
    await treeViews.$registerTreeDataProvider(VIEW_ID)
    // The view mounts and starts the initial pull; simulating a provider that
    // refreshes while that first pull is still in flight.
    await renderView(services)
    await act(async () => {
      await treeViews.$refresh(VIEW_ID)
    })
    await act(async () => {
      resolveStale?.([dto(99, 'root-stale')])
    })
    expect(extHost.$getChildren).toHaveBeenCalledTimes(2)
    expect(screen.getByText('root-fresh')).toBeTruthy()
    expect(screen.queryByText('root-stale')).toBeNull()
  })

  it('does not push expansion state for default-expanded nodes on first render', async () => {
    const { treeViews, extHost, services } = setup({
      root: [dto(1, 'root-a', { collapsibleState: 2 })],
      '1': [dto(2, 'child')],
    })
    await treeViews.$registerTreeDataProvider(VIEW_ID)
    await renderView(services)

    // onDidExpandElement is a user-interaction event in vscode — merely
    // rendering a `collapsibleState: Expanded` node must not synthesize it.
    expect(
      screen.getByText('root-a').closest('[role="treeitem"]')!.getAttribute('aria-expanded'),
    ).toBe('true')
    expect(extHost.$acceptExpansionState).not.toHaveBeenCalled()
  })

  it('pushes expansion only for the node the user actually toggled', async () => {
    const { treeViews, extHost, services } = setup({
      root: [dto(1, 'a', { collapsibleState: 1 })],
      '1': [dto(2, 'b', { collapsibleState: 1 })],
      '2': [dto(3, 'c')],
    })
    await treeViews.$registerTreeDataProvider(VIEW_ID)
    await renderView(services)

    fireEvent.click(screen.getByText('a'))
    await act(async () => {})
    fireEvent.click(screen.getByText('b'))
    await act(async () => {})
    expect(extHost.$acceptExpansionState.mock.calls).toEqual([
      [VIEW_ID, 1, true],
      [VIEW_ID, 2, true],
    ])

    // Collapsing 'a' hides 'b' — but the user never collapsed 'b'.
    fireEvent.click(screen.getByText('a'))
    await act(async () => {})
    expect(extHost.$acceptExpansionState.mock.calls).toEqual([
      [VIEW_ID, 1, true],
      [VIEW_ID, 2, true],
      [VIEW_ID, 1, false],
    ])
  })

  it('pushes no expansion changes across a $refresh with rebuilt handles', async () => {
    const backing = { root: [dto(1, 'a', { collapsibleState: 1 })] }
    const { treeViews, extHost, services } = setup(backing)
    await treeViews.$registerTreeDataProvider(VIEW_ID)
    await renderView(services)

    fireEvent.click(screen.getByText('a'))
    await act(async () => {})
    expect(extHost.$acceptExpansionState.mock.calls).toEqual([[VIEW_ID, 1, true]])
    extHost.$acceptExpansionState.mockClear()

    // The host re-allocates handles on refresh; a diff of rendered rows would
    // report a collapse for the dead handle 1 and a "new" state for handle 7.
    backing.root = [dto(7, 'a2', { collapsibleState: 1 })]
    await act(async () => {
      await treeViews.$refresh(VIEW_ID)
    })
    expect(screen.getByText('a2')).toBeTruthy()
    expect(extHost.$acceptExpansionState).not.toHaveBeenCalled()
  })

  it('re-pulls the roots after a $refresh instead of going empty', async () => {
    const backing = { root: [dto(1, 'root-a')] }
    const { treeViews, services } = setup(backing)
    await treeViews.$registerTreeDataProvider(VIEW_ID)
    await renderView(services)
    expect(screen.getByText('root-a')).toBeTruthy()

    backing.root = [dto(2, 'root-renamed')]
    await act(async () => {
      await treeViews.$refresh(VIEW_ID)
    })
    expect(screen.queryByText('root-a')).toBeNull()
    expect(screen.getByText('root-renamed')).toBeTruthy()
  })
})
