/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for NavigationControls: enabled state tracks IHistoryService and clicks
 *  dispatch the Go Back / Go Forward commands.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import {
  Emitter,
  ICommandService,
  IHistoryService,
  InstantiationService,
  ServiceCollection,
} from '@universe-editor/platform'
import { ServicesContext } from '../../useService.js'
import { NavigationControls } from '../NavigationControls.js'

function makeHistory() {
  const emitter = new Emitter<void>()
  let back = false
  let forward = false
  const service = {
    _serviceBrand: undefined,
    onDidChange: emitter.event,
    canGoBack: () => back,
    canGoForward: () => forward,
  } as unknown as IHistoryService
  return {
    service,
    set(nextBack: boolean, nextForward: boolean) {
      back = nextBack
      forward = nextForward
      emitter.fire()
    },
  }
}

function renderControls(history: IHistoryService, executed: string[]) {
  const sc = new ServiceCollection()
  sc.set(IHistoryService, history)
  sc.set(ICommandService, {
    _serviceBrand: undefined,
    executeCommand: (id: string) => {
      executed.push(id)
      return Promise.resolve(undefined)
    },
  } as unknown as ICommandService)
  const container = new InstantiationService(sc)
  return render(
    <ServicesContext.Provider value={container}>
      <NavigationControls />
    </ServicesContext.Provider>,
  )
}

describe('NavigationControls', () => {
  it('disables both buttons when history is empty', () => {
    const history = makeHistory()
    renderControls(history.service, [])
    expect(screen.getByTestId('titlebar-nav-back')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('titlebar-nav-forward')).toHaveProperty('disabled', true)
  })

  it('updates enabled state when history changes', () => {
    const history = makeHistory()
    renderControls(history.service, [])

    act(() => history.set(true, false))
    expect(screen.getByTestId('titlebar-nav-back')).toHaveProperty('disabled', false)
    expect(screen.getByTestId('titlebar-nav-forward')).toHaveProperty('disabled', true)

    act(() => history.set(false, true))
    expect(screen.getByTestId('titlebar-nav-back')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('titlebar-nav-forward')).toHaveProperty('disabled', false)
  })

  it('dispatches goBack / goForward commands on click', () => {
    const history = makeHistory()
    const executed: string[] = []
    renderControls(history.service, executed)
    act(() => history.set(true, true))

    fireEvent.click(screen.getByTestId('titlebar-nav-back'))
    fireEvent.click(screen.getByTestId('titlebar-nav-forward'))
    expect(executed).toEqual(['workbench.action.goBack', 'workbench.action.goForward'])
  })
})
