/*---------------------------------------------------------------------------------------------
 *  ActivityBar Vim surface: roving tabindex, j/k move the cursor between
 *  containers without opening them, Enter activates + focuses the container's
 *  first view, and gg/G reach the ends.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import {
  ILayoutService,
  IViewsService,
  InstantiationService,
  observableValue,
} from '@universe-editor/platform'
import {
  __resetVimSurfacesForTests,
  getActiveVimSurface,
  type IVimSurfaceActions,
} from '@universe-editor/workbench-ui'
import {
  makeVimTestServices,
  registerTestContainers,
  type VimTestServices,
} from '../../../__tests__/_helpers/vimTestHarness.js'
import { IActivityService } from '../../../services/activity/ActivityService.js'
import { ServicesContext } from '../../useService.js'
import { ActivityBar } from '../ActivityBar.js'

// Created per test in beforeEach (and disposed in afterEach), never at module scope.
let harness: VimTestServices

function registerContainers(count: number): string[] {
  return registerTestContainers(harness, count, {
    idPrefix: 'vim.activity',
    icon: (i) => (i === 0 ? 'files' : 'search'),
  })
}

function setup() {
  const openViewContainer = vi.fn()
  const closeViewContainer = vi.fn()
  const focusView = vi.fn(() => Promise.resolve(true))
  const setVisible = vi.fn()
  const { services } = harness

  const activeContainerByLocation = observableValue<Readonly<Record<number, string | undefined>>>(
    'vim.activity.active',
    {},
  )
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
    harness = makeVimTestServices()
    __resetVimSurfacesForTests()
  })
  afterEach(() => {
    cleanup()
    __resetVimSurfacesForTests()
    harness.dispose()
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
    act(() => surfaceActions().first?.(0))
    expect(document.activeElement).toBe(item(0))
    act(() => surfaceActions().last?.(0))
    expect(document.activeElement).toBe(item(2))
  })

  it('1G goes to the first container (a typed count is the 1-based target)', () => {
    registerContainers(3)
    setup()
    item(2).focus()
    act(() => surfaceActions().last?.(1))
    expect(document.activeElement).toBe(item(0))
  })

  it('treats a count on gg / G as the 1-based target container', () => {
    registerContainers(3)
    setup()
    item(0).focus()
    act(() => surfaceActions().last?.(2))
    expect(document.activeElement).toBe(item(1))
    act(() => surfaceActions().first?.(3))
    expect(document.activeElement).toBe(item(2))
  })
})
