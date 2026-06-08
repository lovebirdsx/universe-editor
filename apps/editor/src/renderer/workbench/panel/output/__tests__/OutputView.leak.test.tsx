/*---------------------------------------------------------------------------------------------
 *  Regression test: OutputView lives in the Panel, where TiledViews keeps every
 *  view mounted across tab switches. On window reload the Offscreen reconnect
 *  cycle can leave the config subscription's effect cleanup unpaired, so the
 *  disposable must be marked as a singleton (mirrors FileEditor's font effect) to
 *  stay off the leak report. This asserts the subscription is marked singleton.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import {
  IConfigurationService,
  IOutputService,
  InstantiationService,
  ServiceCollection,
  setDisposableTracker,
  type IDisposable,
  type IDisposableTracker,
  type IStorageService,
} from '@universe-editor/platform'
import { OutputService } from '../../../../services/output/OutputService.js'
import { ServicesContext } from '../../../useService.js'
import { OutputView } from '../OutputView.js'

function makeStorage(): IStorageService {
  return {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService
}

afterEach(() => {
  cleanup()
  setDisposableTracker(null)
})

describe('OutputView config subscription', () => {
  it('marks the onDidChangeConfiguration subscription as a singleton', () => {
    const sentinel: IDisposable = { dispose: vi.fn() }
    const config: IConfigurationService = {
      _serviceBrand: undefined,
      get: vi.fn().mockReturnValue(undefined),
      getMerged: vi.fn().mockReturnValue({}),
      update: vi.fn(),
      loadLayer: vi.fn(),
      getLayerSnapshot: vi.fn().mockReturnValue({}),
      getValueOrigin: vi.fn().mockReturnValue(undefined),
      onDidChangeConfiguration: vi.fn().mockReturnValue(sentinel),
    }

    const singletons = new Set<IDisposable>()
    const tracker: IDisposableTracker = {
      trackDisposable: () => {},
      setParent: () => {},
      markAsDisposed: () => {},
      markAsSingleton: (d) => singletons.add(d),
    }
    setDisposableTracker(tracker)

    const services = new ServiceCollection()
    services.set(IOutputService, new OutputService(makeStorage()))
    services.set(IConfigurationService, config)
    const instantiation = new InstantiationService(services)

    render(
      <ServicesContext.Provider value={instantiation}>
        <OutputView />
      </ServicesContext.Provider>,
    )

    expect(config.onDidChangeConfiguration).toHaveBeenCalled()
    expect(singletons.has(sentinel)).toBe(true)
  })
})
