/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for the LayoutControls "Configure Layout" dropdown: opens from the
 *  chevron, lists the registered visibility commands, executes and closes on pick.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, it, expect } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  ContextKeyService,
  ICommandService,
  IContextKeyService,
  ILayoutService,
  InstantiationService,
  MenuId,
  MenuRegistry,
  PartId,
  ServiceCollection,
  constObservable,
  type IDisposable,
} from '@universe-editor/platform'
import { ServicesContext } from '../../useService.js'
import { LayoutControls } from '../LayoutControls.js'

function makeContainer(executed: string[]) {
  const sc = new ServiceCollection()
  sc.set(IContextKeyService, new ContextKeyService())
  sc.set(ILayoutService, {
    _serviceBrand: undefined,
    visible: constObservable({
      [PartId.ActivityBar]: true,
      [PartId.SideBar]: true,
      [PartId.SecondarySideBar]: false,
      [PartId.EditorArea]: true,
      [PartId.Panel]: false,
      [PartId.StatusBar]: true,
    }),
    toggleVisible: () => {},
    getVisible: () => true,
    setVisible: () => {},
  } as unknown as ILayoutService)
  sc.set(ICommandService, {
    _serviceBrand: undefined,
    executeCommand: (id: string) => {
      executed.push(id)
      return Promise.resolve(undefined)
    },
  } as unknown as ICommandService)
  return new InstantiationService(sc)
}

describe('LayoutControls — Configure Layout dropdown', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()!.dispose()
  })

  function registerMenuItems() {
    disposables.push(
      MenuRegistry.addMenuItem(MenuId.LayoutControlMenu, {
        command: 'workbench.action.toggleSidebarVisibility',
        title: 'Toggle Primary Side Bar',
        group: '0_visibility',
        order: 0,
      }),
      MenuRegistry.addMenuItem(MenuId.LayoutControlMenu, {
        command: 'workbench.action.togglePanel',
        title: 'Toggle Panel',
        group: '0_visibility',
        order: 1,
      }),
    )
  }

  it('opens the dropdown listing registered layout commands', () => {
    registerMenuItems()
    render(
      <ServicesContext.Provider value={makeContainer([])}>
        <LayoutControls />
      </ServicesContext.Provider>,
    )

    expect(screen.queryByText('Toggle Primary Side Bar')).toBeNull()
    fireEvent.click(screen.getByTestId('titlebar-layout-menu'))
    expect(screen.getByText('Toggle Primary Side Bar')).toBeTruthy()
    expect(screen.getByText('Toggle Panel')).toBeTruthy()
  })

  it('executes the picked command and closes the dropdown', () => {
    registerMenuItems()
    const executed: string[] = []
    render(
      <ServicesContext.Provider value={makeContainer(executed)}>
        <LayoutControls />
      </ServicesContext.Provider>,
    )

    fireEvent.click(screen.getByTestId('titlebar-layout-menu'))
    fireEvent.click(screen.getByText('Toggle Panel'))
    expect(executed).toEqual(['workbench.action.togglePanel'])
    expect(screen.queryByText('Toggle Panel')).toBeNull()
  })

  it('closes on Escape', () => {
    registerMenuItems()
    render(
      <ServicesContext.Provider value={makeContainer([])}>
        <LayoutControls />
      </ServicesContext.Provider>,
    )

    fireEvent.click(screen.getByTestId('titlebar-layout-menu'))
    expect(screen.getByText('Toggle Panel')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByText('Toggle Panel')).toBeNull()
  })
})
