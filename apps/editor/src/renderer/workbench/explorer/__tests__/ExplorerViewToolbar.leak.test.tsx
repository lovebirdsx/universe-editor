/*---------------------------------------------------------------------------------------------
 *  Regression test: ExplorerViewToolbar lives in the sidebar header (viewToolbarMap),
 *  kept mounted across container switches. On window reload the Offscreen reconnect
 *  cycle can leave the onDidChangeStructure effect cleanup unpaired, so the
 *  subscription must be marked as a singleton (mirrors ExplorerView's selection
 *  effect) to stay off the leak report. This asserts it is marked singleton.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import {
  ICommandService,
  InstantiationService,
  ServiceCollection,
  setDisposableTracker,
  type IDisposable,
  type IDisposableTracker,
} from '@universe-editor/platform'
import { IExplorerTreeService } from '../../../services/explorer/ExplorerTreeService.js'
import type { ExplorerTreeService } from '../../../services/explorer/ExplorerTreeService.js'
import { ServicesContext } from '../../useService.js'
import { ExplorerViewToolbar } from '../ExplorerViewToolbar.js'

afterEach(() => {
  cleanup()
  setDisposableTracker(null)
})

describe('ExplorerViewToolbar structure subscription', () => {
  it('marks the onDidChangeStructure subscription as a singleton', () => {
    const sentinel: IDisposable = { dispose: vi.fn() }
    const tree = {
      _serviceBrand: undefined,
      root: null,
      onDidChangeStructure: vi.fn().mockReturnValue(sentinel),
    } as unknown as ExplorerTreeService

    const commandService = {
      _serviceBrand: undefined,
      executeCommand: vi.fn().mockResolvedValue(undefined),
    } as unknown as ICommandService

    const singletons = new Set<IDisposable>()
    const tracker: IDisposableTracker = {
      trackDisposable: () => {},
      setParent: () => {},
      markAsDisposed: () => {},
      markAsSingleton: (d) => singletons.add(d),
    }
    setDisposableTracker(tracker)

    const services = new ServiceCollection()
    services.set(IExplorerTreeService, tree)
    services.set(ICommandService, commandService)
    const instantiation = new InstantiationService(services)

    render(
      <ServicesContext.Provider value={instantiation}>
        <ExplorerViewToolbar />
      </ServicesContext.Provider>,
    )

    expect(tree.onDidChangeStructure).toHaveBeenCalled()
    expect(singletons.has(sentinel)).toBe(true)
  })
})
