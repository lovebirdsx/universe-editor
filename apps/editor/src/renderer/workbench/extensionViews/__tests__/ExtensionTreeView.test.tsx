/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/extensionViews/ExtensionTreeView.tsx
 *
 *  Covers the rendered tree against a real TreeViewsService wired to a fake ext
 *  host: lazy children pulls on expand, interaction callbacks flowing back
 *  (selection / expansion), leaf command execution with revived URI arguments,
 *  and the `view/item/context` menu scoped with view/viewItem keys.
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
  URI,
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

  it('runs the item command on click with URI arguments revived', async () => {
    const resource = URI.file('/repo/a.ts')
    const { treeViews, executeCommand, services } = setup({
      root: [
        dto(1, 'root-a', {
          command: { command: 'test.open', title: 'Open', arguments: [resource.toJSON()] },
        }),
      ],
    })
    await treeViews.$registerTreeDataProvider(VIEW_ID)
    await renderView(services)

    fireEvent.click(screen.getByText('root-a'))
    expect(executeCommand).toHaveBeenCalledTimes(1)
    const [commandId, arg] = executeCommand.mock.calls[0] as [string, unknown]
    expect(commandId).toBe('test.open')
    expect(arg instanceof URI && arg.toString()).toBe(resource.toString())
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
