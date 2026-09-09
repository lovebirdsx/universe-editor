import { describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import {
  IConfigurationService,
  IOutputService,
  InstantiationService,
  ServiceCollection,
  type IStorageService,
} from '@universe-editor/platform'
import { OutputService } from '../../../../services/output/OutputService.js'
import {
  OutputModelService,
  IOutputModelService,
} from '../../../../services/output/OutputModelService.js'
import { ServicesContext } from '../../../useService.js'
import { OutputView } from '../OutputView.js'

const mockConfigService: IConfigurationService = {
  _serviceBrand: undefined,
  get: vi.fn().mockReturnValue(undefined),
  getMerged: vi.fn().mockReturnValue({}),
  update: vi.fn(),
  loadLayer: vi.fn(),
  getLayerSnapshot: vi.fn().mockReturnValue({}),
  getValueOrigin: vi.fn().mockReturnValue(undefined),
  getValueForTarget: vi.fn().mockReturnValue(undefined),
  getValueOriginForTarget: vi.fn().mockReturnValue(undefined),
  onDidChangeConfiguration: vi.fn().mockReturnValue({ dispose: vi.fn() }),
}

function makeStorage(): IStorageService {
  return {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService
}

function renderOutputView(outputService = new OutputService(makeStorage())) {
  const services = new ServiceCollection()
  services.set(IOutputService, outputService)
  services.set(IOutputModelService, new OutputModelService(outputService, makeStorage()))
  services.set(IConfigurationService, mockConfigService)
  const instantiation = new InstantiationService(services)

  render(
    <ServicesContext.Provider value={instantiation}>
      <OutputView />
    </ServicesContext.Provider>,
  )

  return outputService
}

describe('OutputView', () => {
  it('shows the empty state when there is no active channel at all', () => {
    renderOutputView()
    expect(screen.getByText('No output.')).toBeTruthy()
  })

  it('mounts the editor for an active channel that has no content yet (Bug: empty channel never mounts LogOutputView → focus strands on the ViewBody fallback)', async () => {
    // Repro for the first-open-of-an-empty-channel focus bug: an active channel
    // with no content has `activeChannelHasContent === false`. If OutputView
    // gates the editor on that flag, LogOutputView never mounts for an empty
    // channel → no focusable primary is ever registered → focusView() strands
    // keyboard focus on the ViewBody fallback container. VSCode parity: an
    // output channel is always a focusable read-only editor, even when empty.
    const outputService = new OutputService(makeStorage())
    outputService.createChannel('empty-channel')
    outputService.setActiveChannel('empty-channel')
    renderOutputView(outputService)

    // The editor must mount (not the "No output." placeholder) even though the
    // channel is empty, so its focusable primary exists for focusView().
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByText('No output.')).toBeNull()
  })

  it('does not embed a toolbar (toolbar lives in the shared header now)', () => {
    renderOutputView()
    expect(screen.queryByRole('button', { name: 'Clear Output' })).toBeNull()
    expect(screen.queryByLabelText('Select output channel')).toBeNull()
  })
})
