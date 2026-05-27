import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  IOutputService,
  InstantiationService,
  ServiceCollection,
  type IStorageService,
} from '@universe-editor/platform'
import { OutputService } from '../../../../services/output/OutputService.js'
import { ServicesContext } from '../../../useService.js'
import { OutputViewToolbar } from '../OutputViewToolbar.js'

function makeStorage(): IStorageService {
  return {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService
}

function renderToolbar(outputService = new OutputService(makeStorage())) {
  const services = new ServiceCollection()
  services.set(IOutputService, outputService)
  const instantiation = new InstantiationService(services)
  render(
    <ServicesContext.Provider value={instantiation}>
      <OutputViewToolbar />
    </ServicesContext.Provider>,
  )
  return outputService
}

describe('OutputViewToolbar', () => {
  it('lists every channel and switches the active one', () => {
    const outputService = new OutputService(makeStorage())
    outputService.createChannel('Renderer')
    outputService.createChannel('Main')
    renderToolbar(outputService)

    const select = screen.getByLabelText<HTMLSelectElement>('Select output channel')
    fireEvent.change(select, { target: { value: 'Main' } })

    expect(outputService.activeChannelName.get()).toBe('Main')
  })

  it('pins the All channel first when present', () => {
    const outputService = new OutputService(makeStorage())
    outputService.createChannel('Renderer')
    outputService.createChannel('All')
    outputService.createChannel('Main')
    renderToolbar(outputService)

    const options = screen.getAllByRole<HTMLOptionElement>('option').map((o) => o.value)
    expect(options[0]).toBe('All')
  })
})
