import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import {
  CommandsRegistry,
  ICommandService,
  IOutputService,
  InstantiationService,
  LogLevel,
  ServiceCollection,
  registerAction2,
  type IDisposable,
  type IStorageService,
} from '@universe-editor/platform'
import {
  OutputModelService,
  IOutputModelService,
} from '../../../../services/output/OutputModelService.js'
import { OutputService } from '../../../../services/output/OutputService.js'
import { ToggleOutputAutoScrollAction } from '../../../../actions/logActions.js'
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

function makeCommandService(instantiation: InstantiationService): ICommandService {
  return {
    _serviceBrand: undefined,
    executeCommand: <T = unknown,>(id: string, ...args: unknown[]) => {
      const command = CommandsRegistry.getCommand(id)
      if (!command) return Promise.resolve(undefined)
      return instantiation.invokeFunction((accessor) =>
        command.handler(accessor, ...args),
      ) as Promise<T | undefined>
    },
  } as unknown as ICommandService
}

function renderToolbar(outputService = new OutputService(makeStorage())) {
  const services = new ServiceCollection()
  const outputModels = new OutputModelService(outputService, makeStorage())
  services.set(IOutputService, outputService)
  services.set(IOutputModelService, outputModels)
  const instantiation = new InstantiationService(services)
  services.set(ICommandService, makeCommandService(instantiation))
  render(
    <ServicesContext.Provider value={instantiation}>
      <OutputViewToolbar />
    </ServicesContext.Provider>,
  )
  return { outputService, outputModels }
}

describe('OutputViewToolbar', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

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

  it('sorts the remaining channels alphabetically (matching the quick pick)', () => {
    const outputService = new OutputService(makeStorage())
    outputService.createChannel('Renderer')
    outputService.createChannel('All')
    outputService.createChannel('Main')
    outputService.createChannel('Extension Host')
    renderToolbar(outputService)

    const options = screen.getAllByRole<HTMLOptionElement>('option').map((o) => o.value)
    expect(options).toEqual(['All', 'Extension Host', 'Main', 'Renderer'])
  })

  it('scroll lock button reflects autoScroll state via aria-pressed', () => {
    const outputService = new OutputService(makeStorage())
    renderToolbar(outputService)

    const lockButton = screen.getByTestId('output-scroll-lock')
    expect(lockButton.getAttribute('aria-pressed')).toBe('false')
    expect(lockButton.getAttribute('aria-label')).toBe('Turn Auto Scrolling Off')
  })

  it('clicking the scroll lock button toggles autoScroll through the command', async () => {
    disposables.push(registerAction2(ToggleOutputAutoScrollAction))
    const outputService = new OutputService(makeStorage())
    renderToolbar(outputService)

    const lockButton = screen.getByTestId('output-scroll-lock')
    fireEvent.click(lockButton)
    await vi.waitFor(() => expect(lockButton.getAttribute('aria-pressed')).toBe('true'))
    expect(lockButton.getAttribute('aria-label')).toBe('Turn Auto Scrolling On')

    fireEvent.click(lockButton)
    await vi.waitFor(() => expect(lockButton.getAttribute('aria-pressed')).toBe('false'))
    expect(lockButton.getAttribute('aria-label')).toBe('Turn Auto Scrolling Off')
  })

  it('typing in the filter input updates the filter text', () => {
    const { outputModels } = renderToolbar()

    const input = screen.getByTestId('output-filter-input')
    fireEvent.change(input, { target: { value: 'foo, !bar' } })
    expect(outputModels.filterText.get()).toBe('foo, !bar')
  })

  it('the level menu toggles levels off and on', () => {
    const { outputModels } = renderToolbar()

    fireEvent.click(screen.getByTestId('output-filter-levels'))
    const debugCheckbox = screen.getByTestId('output-level-debug')
    fireEvent.click(debugCheckbox)
    expect(outputModels.hiddenLevels.get().has(LogLevel.Debug)).toBe(true)

    fireEvent.click(debugCheckbox)
    expect(outputModels.hiddenLevels.get().has(LogLevel.Debug)).toBe(false)
  })

  it('clear filters inside the level menu resets text and levels', () => {
    const { outputModels } = renderToolbar()
    act(() => {
      outputModels.setFilterText('abc')
      outputModels.setLevelHidden(LogLevel.Warning, true)
    })

    fireEvent.click(screen.getByTestId('output-filter-levels'))
    fireEvent.click(screen.getByTestId('output-filter-clear'))
    expect(outputModels.filterText.get()).toBe('')
    expect(outputModels.hiddenLevels.get().size).toBe(0)
  })

  it('hides the clear-filters action until a filter is active', () => {
    renderToolbar()
    fireEvent.click(screen.getByTestId('output-filter-levels'))
    expect(screen.queryByTestId('output-filter-clear')).toBeNull()
  })
})
