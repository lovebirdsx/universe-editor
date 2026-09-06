/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PaneCompositeHeader tab-strip click behaviour.
 *
 *  The Panel and the Secondary Side Bar switch containers through this tab strip
 *  and have no ActivityBar, so this click is their only "activate a container"
 *  path. It has to focus the container's primary view the way ActivityBar does,
 *  or DOM focus stays stranded and a view that seeds its keyboard cursor on
 *  focus shows nothing selected.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
import { ViewDescriptorService } from '../../../services/views/ViewDescriptorService.js'
import { ServicesContext } from '../../useService.js'
import { PaneCompositeHeader } from '../PaneCompositeHeader.js'

function makeStorage(): IStorageService {
  return {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService
}

const disposables: Array<{ dispose: () => void }> = []

// Ids are unique per test: ViewContainerRegistry is module-global, and reusing
// an id across tests makes a stale registration indistinguishable from a fresh
// one if anything outlives its dispose.
let idSeq = 0

/** Register `count` Panel containers, each with a view unless listed in `viewless`. */
function registerContainers(count: number, viewless: readonly number[] = []) {
  const prefix = `test.container.${idSeq++}`
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
    if (!viewless.includes(i)) {
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
  }
  return ids
}

function setup() {
  const focusView = vi.fn(() => Promise.resolve(true))
  const openViewContainer = vi.fn()

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
  services.set(IViewsService, { _serviceBrand: undefined, openViewContainer } as never)
  services.set(ILayoutService, {
    _serviceBrand: undefined,
    focusView,
    panelMaximized: observableValue<boolean>('test.panelMaximized', false),
    setVisible: () => {},
    togglePanelMaximized: () => {},
  } as never)

  render(
    <ServicesContext.Provider value={new InstantiationService(services)}>
      <PaneCompositeHeader
        mode="tabs"
        location={ViewContainerLocation.Panel}
        partId={'panel' as never}
        activeContainer={undefined}
        onlyView={undefined}
      />
    </ServicesContext.Provider>,
  )
  return { focusView, openViewContainer }
}

afterEach(() => {
  cleanup()
  while (disposables.length) disposables.pop()?.dispose()
})

describe('PaneCompositeHeader — tab click', () => {
  it('focuses the container primary view rather than only opening the container', () => {
    const [, second] = registerContainers(2)
    const { focusView, openViewContainer } = setup()

    fireEvent.click(screen.getByTestId(`view-container-tab-${second}`))

    expect(focusView).toHaveBeenCalledWith(`${second}.main`, { source: 'user' })
    // focusView opens the container itself, so a second call would be redundant.
    expect(openViewContainer).not.toHaveBeenCalled()
  })

  it('renders no tab for a container with no views, so the click always has one to focus', () => {
    // getViewContainersByLocation filters these out, which is what lets the
    // click reach for `getViewsByContainer(...)[0]` — the openViewContainer
    // fallback beside it only guards against that invariant changing.
    const [withView, viewless] = registerContainers(2, [1])
    setup()

    expect(screen.getByTestId(`view-container-tab-${withView}`)).toBeTruthy()
    expect(screen.queryByTestId(`view-container-tab-${viewless}`)).toBeNull()
  })

  it('does nothing for a lone container — there is nothing to switch to', () => {
    const [only] = registerContainers(1)
    const { focusView, openViewContainer } = setup()

    fireEvent.click(screen.getByTestId(`view-container-tab-${only}`))

    expect(focusView).not.toHaveBeenCalled()
    expect(openViewContainer).not.toHaveBeenCalled()
  })
})
