import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import {
  IViewDescriptorService,
  InstantiationService,
  ServiceCollection,
  ViewContainerLocation,
  ViewContainerRegistry,
  ViewRegistry,
  type IStorageService,
  type IWorkspaceService,
} from '@universe-editor/platform'
import { IViewsService } from '@universe-editor/platform'
import { ViewsService } from '../../../services/views/ViewsService.js'
import { ViewDescriptorService } from '../../../services/views/ViewDescriptorService.js'
import { ViewComponentRegistry } from '../../../services/views/ViewComponentRegistry.js'
import { ServicesContext } from '../../useService.js'
import { PaneCompositePart } from '../../paneComposite/PaneCompositePart.js'
import { sideBarConfig } from '../../paneComposite/paneCompositeConfigs.js'

vi.mock('../../paneComposite/PaneCompositeHeader.js', () => ({
  PaneCompositeHeader: () => <div data-testid="view-container-header" />,
}))

vi.mock('../ViewPane.js', () => ({
  ViewPane: ({
    title,
    children,
    open,
  }: {
    title: string
    children: React.ReactNode
    open: boolean
  }) => (
    <div data-testid={`view-pane-${title}`} data-open={open}>
      {children}
    </div>
  ),
}))

type ROEntry = { contentRect: { width: number; height: number } }
const roCallbacks: Array<(entries: ROEntry[]) => void> = []

class FakeResizeObserver {
  constructor(callback: (entries: ROEntry[]) => void) {
    roCallbacks.push(callback)
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function fireLastResizeObserver(width: number, height: number) {
  const callback = roCallbacks[roCallbacks.length - 1]
  if (!callback) throw new Error('no ResizeObserver instance')
  callback([{ contentRect: { width, height } }])
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

const stubWorkspace = { current: {} } as unknown as IWorkspaceService

const CONTAINER_ID = 'test.container'

function renderSideBar() {
  const services = new ServiceCollection()
  const viewDescriptorService = new ViewDescriptorService(makeStorage(), stubWorkspace)
  services.set(IViewDescriptorService, viewDescriptorService)
  const viewsService = new ViewsService(makeStorage(), stubWorkspace, viewDescriptorService)
  viewsService.openViewContainer(CONTAINER_ID)
  services.set(IViewsService, viewsService)
  const inst = new InstantiationService(services)
  const result = render(
    <ServicesContext.Provider value={inst}>
      <PaneCompositePart part={undefined} config={sideBarConfig} />
    </ServicesContext.Provider>,
  )
  return { viewDescriptorService, ...result }
}

describe('ViewPaneContainer', () => {
  const disposables: Array<{ dispose: () => void }> = []

  beforeEach(() => {
    roCallbacks.length = 0
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    disposables.push(
      ViewContainerRegistry.registerViewContainer({
        id: CONTAINER_ID,
        label: 'Test',
        icon: 'test',
        order: 1,
        location: ViewContainerLocation.SideBar,
      }),
    )
    for (const [index, id] of ['test.view.a', 'test.view.b'].entries()) {
      disposables.push(
        ViewRegistry.registerView({
          id,
          name: id,
          containerId: CONTAINER_ID,
          componentKey: `test.component.${id}`,
          order: index,
        }),
      )
      disposables.push(
        ViewComponentRegistry.register(`test.component.${id}`, () => <div>{id}</div>),
      )
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    while (disposables.length) disposables.pop()?.dispose()
  })

  it('resizes open panes around a collapsed one after the split view has laid out', () => {
    const { viewDescriptorService } = renderSideBar()
    act(() => fireLastResizeObserver(800, 600))
    expect(viewDescriptorService.getViewState('test.view.a').size).toBe(300)

    act(() => viewDescriptorService.setViewCollapsed('test.view.a', true))

    expect(viewDescriptorService.getViewState('test.view.a').size).toBe(28)
    expect(viewDescriptorService.getViewState('test.view.b').size).toBe(572)
  })

  it('does not resize against a remounted Allotment whose panes are not reconciled yet', () => {
    const { viewDescriptorService } = renderSideBar()
    act(() => fireLastResizeObserver(800, 600))
    expect(viewDescriptorService.getViewState('test.view.a').size).toBe(300)

    // Reorder → viewIdsKey changes → Allotment remounts with an empty SplitView
    // whose panes only appear after the next ResizeObserver tick. The collapse
    // landing in that window must not drive resize() against the stale geometry.
    act(() => viewDescriptorService.moveViewInContainer(CONTAINER_ID, 'test.view.b', 'test.view.a'))
    act(() => viewDescriptorService.setViewCollapsed('test.view.a', true))

    expect(screen.getByTestId('view-pane-test.view.a')).toBeTruthy()
  })
})
