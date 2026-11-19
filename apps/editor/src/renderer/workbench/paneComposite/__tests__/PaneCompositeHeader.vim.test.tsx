/*---------------------------------------------------------------------------------------------
 *  ViewContainer header Vim surface (tabs mode): h/l cycle containers while
 *  focus stays on the strip, Enter hands focus to the active container's first
 *  view, and `focusViewContainerTabs` focuses the active tab.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import {
  ContextKeyService,
  IContextKeyService,
  ILayoutService,
  IViewDescriptorService,
  IViewsService,
  InstantiationService,
  NullLogger,
  ServiceCollection,
  ViewContainerLocation,
  ViewContainerRegistry,
  ViewRegistry,
  observableValue,
  type ILoggerService,
  type IStorageService,
  type IWorkspaceService,
} from '@universe-editor/platform'
import {
  __resetVimSurfacesForTests,
  getActiveVimSurface,
  type IVimSurfaceActions,
} from '@universe-editor/workbench-ui'
import { ViewDescriptorService } from '../../../services/views/ViewDescriptorService.js'
import { ServicesContext } from '../../useService.js'
import { PaneCompositeHeader } from '../PaneCompositeHeader.js'
import { focusViewContainerTabsArea } from '../viewContainerTabsFocus.js'

function makeStorage(): IStorageService {
  return {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService
}

const disposables: Array<{ dispose(): void }> = []

let idSeq = 0

function registerContainers(count: number): string[] {
  const prefix = `vim.panel.${idSeq++}`
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const id = `${prefix}.${i}`
    ids.push(id)
    disposables.push(
      ViewContainerRegistry.registerViewContainer({
        id,
        label: `Container ${i}`,
        icon: 'output',
        order: i,
        location: ViewContainerLocation.Panel,
      }),
    )
    disposables.push(
      ViewRegistry.registerView({
        id: `${id}.main`,
        name: `View ${i}`,
        containerId: id,
        componentKey: `${id}.main`,
        order: 1,
      }),
    )
  }
  return ids
}

function setup(ids: readonly string[], mode: 'tabs' | 'label' = 'tabs') {
  let activeId: string | undefined = ids[0]
  const focusView = vi.fn(() => Promise.resolve(true))
  const openViewContainer = vi.fn((id: string) => {
    activeId = id
  })
  const setVisible = vi.fn()
  const contextKeyService = new ContextKeyService()
  disposables.push(contextKeyService)
  const viewDescriptorService = new ViewDescriptorService(
    makeStorage(),
    { current: {} } as unknown as IWorkspaceService,
    contextKeyService,
    { createLogger: () => new NullLogger() } as unknown as ILoggerService,
  )

  const services = new ServiceCollection()
  services.set(IContextKeyService, contextKeyService)
  services.set(IViewDescriptorService, viewDescriptorService)
  services.set(IViewsService, {
    _serviceBrand: undefined,
    openViewContainer,
    closeViewContainer: vi.fn(),
    getActiveViewContainerId: () => activeId,
    activeContainerByLocation: observableValue('vim.panel.active', {}),
  } as never)
  services.set(ILayoutService, {
    _serviceBrand: undefined,
    focusView,
    setVisible,
    panelMaximized: observableValue<boolean>('vim.panel.maximized', false),
    togglePanelMaximized: vi.fn(),
  } as never)

  const instantiation = new InstantiationService(services)
  render(
    <ServicesContext.Provider value={instantiation}>
      <PaneCompositeHeader
        mode={mode}
        location={ViewContainerLocation.Panel}
        partId={'panel' as never}
        activeContainer={viewDescriptorService.getViewContainerById(ids[0]!)}
        onlyView={undefined}
      />
    </ServicesContext.Provider>,
  )
  return { focusView, openViewContainer, setVisible }
}

function surfaceActions(): IVimSurfaceActions {
  const active = getActiveVimSurface(document)
  expect(active).toBeDefined()
  expect(active?.surface.kind).toBe('viewContainerTabs')
  return active!.surface.actions
}

describe('PaneCompositeHeader vim surface', () => {
  beforeEach(() => {
    __resetVimSurfacesForTests()
  })
  afterEach(() => {
    cleanup()
    __resetVimSurfacesForTests()
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('h/l cycle containers and keep focus on the strip', () => {
    const ids = registerContainers(3)
    const { openViewContainer } = setup(ids)

    screen.getByTestId(`view-container-tab-${ids[0]}`).focus()
    act(() => surfaceActions().next?.(1))
    expect(openViewContainer).toHaveBeenLastCalledWith(ids[1])
    expect(document.activeElement).toBe(screen.getByTestId(`view-container-tab-${ids[1]}`))

    act(() => surfaceActions().previous?.(1))
    expect(openViewContainer).toHaveBeenLastCalledWith(ids[0])
    expect(document.activeElement).toBe(screen.getByTestId(`view-container-tab-${ids[0]}`))
  })

  it('gg/G jump to the first and last container', () => {
    const ids = registerContainers(3)
    setup(ids)

    screen.getByTestId(`view-container-tab-${ids[1]}`).focus()
    act(() => surfaceActions().first?.(1))
    expect(document.activeElement).toBe(screen.getByTestId(`view-container-tab-${ids[0]}`))
    act(() => surfaceActions().last?.(1))
    expect(document.activeElement).toBe(screen.getByTestId(`view-container-tab-${ids[2]}`))
  })

  it('Enter focuses the active container’s first view', () => {
    const ids = registerContainers(2)
    const { focusView } = setup(ids)

    screen.getByTestId(`view-container-tab-${ids[1]}`).focus()
    act(() => surfaceActions().activate?.(1, false))
    expect(focusView).toHaveBeenCalledWith(`${ids[0]}.main`, { source: 'user' })
  })

  it('publishes the focus target for focusViewContainerTabs', () => {
    const ids = registerContainers(2)
    setup(ids)

    expect(focusViewContainerTabsArea(ViewContainerLocation.Panel)).toBe(true)
    expect(document.activeElement).toBe(screen.getByTestId(`view-container-tab-${ids[0]}`))
  })

  it('label-mode headers do not publish a tab focus target', () => {
    const ids = registerContainers(2)
    setup(ids, 'label')
    expect(focusViewContainerTabsArea(ViewContainerLocation.Panel)).toBe(false)
  })
})
