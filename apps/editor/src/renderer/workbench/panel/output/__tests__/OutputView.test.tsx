import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  IConfigurationService,
  IOutputService,
  InstantiationService,
  ServiceCollection,
} from '@universe-editor/platform'
import { OutputService } from '../../../../services/output/OutputService.js'
import { ServicesContext } from '../../../useService.js'
import { OutputView } from '../OutputView.js'

const mockConfigService: IConfigurationService = {
  _serviceBrand: undefined,
  get: vi.fn().mockReturnValue(undefined),
  update: vi.fn(),
  loadLayer: vi.fn(),
  getLayerSnapshot: vi.fn().mockReturnValue({}),
  getValueOrigin: vi.fn().mockReturnValue(undefined),
  onDidChangeConfiguration: { event: vi.fn(), dispose: vi.fn() } as never,
}

function renderOutputView(outputService = new OutputService()) {
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
  it('clears the active output channel from the icon button', () => {
    const outputService = new OutputService()
    const channel = outputService.createChannel('Renderer')
    channel.appendLine('ready')
    const clear = vi.spyOn(channel, 'clear')

    renderOutputView(outputService)
    fireEvent.click(screen.getByRole('button', { name: 'Clear Output' }))

    expect(clear).toHaveBeenCalledTimes(1)
  })

  it('disables the clear button when there is no active output channel', () => {
    renderOutputView()

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Clear Output' }).disabled).toBe(
      true,
    )
  })
})
