import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import {
  ICommandService,
  InstantiationService,
  ServiceCollection,
  URI,
  localize,
  type ICommandService as ICommandServiceType,
} from '@universe-editor/platform'
import { IExplorerTreeService } from '../../../services/explorer/ExplorerTreeService.js'
import type { ExplorerTreeService } from '../../../services/explorer/ExplorerTreeService.js'
import { ServicesContext } from '../../useService.js'
import { ExplorerViewToolbar } from '../ExplorerViewToolbar.js'

afterEach(cleanup)

function makeTree(root: URI | null) {
  const refresh = vi.fn().mockResolvedValue(undefined)
  const tree = {
    _serviceBrand: undefined,
    root,
    onDidChangeStructure: vi.fn().mockReturnValue({ dispose: () => {} }),
    refresh,
  } as unknown as ExplorerTreeService
  return { tree, refresh }
}

function renderToolbar(tree: ExplorerTreeService): HTMLElement {
  const commandService = {
    _serviceBrand: undefined,
    executeCommand: vi.fn().mockResolvedValue(undefined),
  } as unknown as ICommandServiceType
  const services = new ServiceCollection()
  services.set(IExplorerTreeService, tree)
  services.set(ICommandService, commandService)
  const instantiation = new InstantiationService(services)
  const { container } = render(
    <ServicesContext.Provider value={instantiation}>
      <ExplorerViewToolbar />
    </ServicesContext.Provider>,
  )
  return container
}

describe('ExplorerViewToolbar refresh', () => {
  it('re-reads the workspace root recursively on click', () => {
    const root = URI.file('/ws')
    const { tree, refresh } = makeTree(root)
    const container = renderToolbar(tree)

    const label = localize('explorer.refresh', 'Refresh Explorer')
    const button = container.querySelector<HTMLButtonElement>(`button[data-tooltip="${label}"]`)
    if (!button) throw new Error('refresh button not found')
    fireEvent.click(button)

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh.mock.calls[0]?.[0]?.toString()).toBe(root.toString())
    expect(refresh.mock.calls[0]?.[1]).toBe(true)
  })
})
