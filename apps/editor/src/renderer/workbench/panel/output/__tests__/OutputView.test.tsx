import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  IConfigurationService,
  IOutputService,
  InstantiationService,
  ServiceCollection,
  type IStorageService,
} from '@universe-editor/platform'
import { OutputService } from '../../../../services/output/OutputService.js'
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
  onDidChangeConfiguration: { event: vi.fn(), dispose: vi.fn() } as never,
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
  it('shows the empty state when no channel has content', () => {
    renderOutputView()
    expect(screen.getByText('No output.')).toBeTruthy()
  })

  it('does not embed a toolbar (toolbar lives in the shared header now)', () => {
    renderOutputView()
    expect(screen.queryByRole('button', { name: 'Clear Output' })).toBeNull()
    expect(screen.queryByLabelText('Select output channel')).toBeNull()
  })
})
