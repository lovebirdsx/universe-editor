import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  IConfigurationService,
  IOutputService,
  InstantiationService,
  ServiceCollection,
  ViewContainerLocation,
  ViewContainerRegistry,
  ViewRegistry,
  observableValue,
  type IStorageService,
  type IWorkspaceService,
} from '@universe-editor/platform'
import { ILayoutService, IViewsService } from '@universe-editor/platform'
import { OutputService } from '../../../services/output/OutputService.js'
import { ViewsService } from '../../../services/views/ViewsService.js'
import { ViewComponentRegistry } from '../../../services/views/ViewComponentRegistry.js'
import { ServicesContext } from '../../useService.js'
import { PaneCompositePart } from '../../paneComposite/PaneCompositePart.js'
import { panelConfig } from '../../paneComposite/paneCompositeConfigs.js'

vi.mock('../../paneComposite/PaneCompositeHeader.js', () => ({
  PaneCompositeHeader: () => <div data-testid="view-container-header" />,
}))

function makeStorage(): IStorageService {
  return {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService
}

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

const stubWorkspace = { current: {} } as unknown as IWorkspaceService

function renderPanel(activeContainerId: string | undefined) {
  const services = new ServiceCollection()
  const viewsService = new ViewsService(makeStorage(), stubWorkspace)
  if (activeContainerId) viewsService.openViewContainer(activeContainerId)
  services.set(IViewsService, viewsService)
  services.set(IOutputService, new OutputService(makeStorage()))
  services.set(IConfigurationService, mockConfigService)
  services.set(ILayoutService, {
    _serviceBrand: undefined,
    getVisible: () => false,
    setVisible: () => {},
    toggleVisible: () => {},
    panelMaximized: observableValue<boolean>('test.panelMaximized', false),
    setPanelMaximized: () => {},
    togglePanelMaximized: () => {},
  } as never)
  const inst = new InstantiationService(services)
  return render(
    <ServicesContext.Provider value={inst}>
      <PaneCompositePart part={undefined} config={panelConfig} />
    </ServicesContext.Provider>,
  )
}

describe('Panel', () => {
  const disposables: Array<{ dispose: () => void }> = []

  afterEach(() => {
    while (disposables.length) disposables.pop()?.dispose()
  })

  function registerOutput() {
    disposables.push(
      ViewContainerRegistry.registerViewContainer({
        id: 'workbench.view.output',
        label: 'Output',
        icon: 'output',
        order: 1,
        location: ViewContainerLocation.Panel,
      }),
    )
    disposables.push(
      ViewRegistry.registerView({
        id: 'workbench.view.output.main',
        name: 'Output',
        containerId: 'workbench.view.output',
        componentKey: 'output.main',
        order: 1,
      }),
    )
    disposables.push(
      ViewComponentRegistry.register('output.main', () => (
        <div data-testid="output-view">Output Content</div>
      )),
    )
  }

  it('renders the active container id on the part element', () => {
    registerOutput()
    renderPanel('workbench.view.output')
    expect(screen.getByTestId('part-panel').getAttribute('data-active-view-container')).toBe(
      'workbench.view.output',
    )
  })

  it('renders the view component bound to the active container', () => {
    registerOutput()
    renderPanel('workbench.view.output')
    expect(screen.getByTestId('output-view')).toBeTruthy()
  })

  it('renders no view content when no container is active', () => {
    registerOutput()
    renderPanel(undefined)
    expect(screen.queryByTestId('output-view')).toBeNull()
    expect(screen.getByTestId('part-panel').getAttribute('data-active-view-container')).toBe('')
  })

  it('always mounts the shared header', () => {
    registerOutput()
    renderPanel('workbench.view.output')
    expect(screen.getByTestId('view-container-header')).toBeTruthy()
  })
})
