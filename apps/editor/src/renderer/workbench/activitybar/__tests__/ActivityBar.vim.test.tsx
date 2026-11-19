/*---------------------------------------------------------------------------------------------
 *  ActivityBar Vim surface: roving tabindex, j/k move the cursor between
 *  containers without opening them, Enter activates + focuses the container's
 *  first view, and gg/G reach the ends.
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
import { IActivityService } from '../../../services/activity/ActivityService.js'
import { ServicesContext } from '../../useService.js'
import { ActivityBar } from '../ActivityBar.js'

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
  const prefix = `vim.activity.${idSeq++}`
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const id = `${prefix}.${i}`
    ids.push(id)
    disposables.push(
      ViewContainerRegistry.registerViewContainer({
        id,
        label: `Container ${i}`,
        icon: i === 0 ? 'files' : 'search',
        order: i,
        location: ViewContainerLocation.SideBar,
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

function setup() {
  const openViewContainer = vi.fn()
  const closeViewContainer = vi.fn()
  const focusView = vi.fn(() => Promise.resolve(true))
  const setVisible = vi.fn()
  const contextKeyService = new ContextKeyService()
  disposables.push(contextKeyService)
  const viewDescriptorService = new ViewDescriptorService(
    makeStorage(),
    { current: {} } as unknown as IWorkspaceService,
    contextKeyService,
    { createLogger: () => new NullLogger() } as unknown as ILoggerService,
  )

  const activeContainerByLocation = observableValue<Readonly<Record<number, string | undefined>>>(
    'vim.activity.active',
    {},
  )
  const services = new ServiceCollection()
  services.set(IContextKeyService, contextKeyService)
  services.set(IViewDescriptorService, viewDescriptorService)
  services.set(IViewsService, {
    _serviceBrand: undefined,
    openViewContainer,
    closeViewContainer,
    getActiveViewContainerId: (location: number) => activeContainerByLocation.get()[location],
    activeContainerByLocation,
  } as never)
  services.set(ILayoutService, {
    _serviceBrand: undefined,
    getVisible: () => true,
    setVisible,
    focusView,
  } as never)
  services.set(IActivityService, {
    _serviceBrand: undefined,
    showActivity: () => ({ dispose: () => {} }),
    getBadge: () => observableValue<undefined>('vim.activity.badge', undefined),
  } as never)

  const instantiation = new InstantiationService(services)
  render(
    <ServicesContext.Provider value={instantiation}>
      <ActivityBar />
    </ServicesContext.Provider>,
  )
  return { openViewContainer, closeViewContainer, focusView, setVisible }
}

function item(index: number): HTMLElement {
  return screen.getAllByTestId(/^activitybar-item-/)[index]!
}

function surfaceActions(): IVimSurfaceActions {
  const active = getActiveVimSurface(document)
  expect(active).toBeDefined()
  expect(active?.surface.kind).toBe('activityBar')
  return active!.surface.actions
}

describe('ActivityBar vim surface', () => {
  beforeEach(() => {
    __resetVimSurfacesForTests()
  })
  afterEach(() => {
    cleanup()
    __resetVimSurfacesForTests()
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('uses a roving tabindex on the items', () => {
    registerContainers(3)
    setup()
    const items = screen.getAllByTestId(/^activitybar-item-/)
    expect(items.map((element) => element.getAttribute('tabindex'))).toEqual(['0', '-1', '-1'])
  })

  it('j/k move focus between containers without opening them', () => {
    registerContainers(3)
    const { openViewContainer, focusView } = setup()
    item(0).focus()
    act(() => surfaceActions().next?.(1))
    expect(document.activeElement).toBe(item(1))
    act(() => surfaceActions().next?.(1))
    expect(document.activeElement).toBe(item(2))
    act(() => surfaceActions().previous?.(1))
    expect(document.activeElement).toBe(item(1))
    expect(openViewContainer).not.toHaveBeenCalled()
    expect(focusView).not.toHaveBeenCalled()
  })

  it('Enter activates the focused container and focuses its first view', () => {
    const ids = registerContainers(3)
    const { focusView } = setup()
    item(0).focus()
    act(() => surfaceActions().next?.(1))
    act(() => surfaceActions().activate?.(1, false))
    expect(focusView).toHaveBeenCalledWith(`${ids[1]}.main`, { source: 'user' })
  })

  it('gg/G go to the first and last container', () => {
    registerContainers(3)
    setup()
    item(1).focus()
    act(() => surfaceActions().first?.(1))
    expect(document.activeElement).toBe(item(0))
    act(() => surfaceActions().last?.(1))
    expect(document.activeElement).toBe(item(2))
  })
})
