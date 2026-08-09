/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionChangesViewToolbar — the list/tree toggle flips
 *  sessionChangesViewState.viewMode; the collapse/expand-all buttons (tree mode
 *  only) bump the shared signal counters consumed by SessionChangesView.
 *--------------------------------------------------------------------------------------------*/

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InstantiationService, ServiceCollection } from '@universe-editor/platform'
import { ServicesContext } from '../../useService.js'
import { SessionChangesViewToolbar } from '../SessionChangesViewToolbar.js'
import { sessionChangesViewState } from '../sessionChangesViewState.js'

function renderToolbar() {
  return render(
    <ServicesContext.Provider value={new InstantiationService(new ServiceCollection())}>
      <SessionChangesViewToolbar />
    </ServicesContext.Provider>,
  )
}

beforeEach(() => sessionChangesViewState._resetForTests())
afterEach(() => {
  cleanup()
  sessionChangesViewState._resetForTests()
})

describe('SessionChangesViewToolbar', () => {
  it('hides the collapse/expand-all buttons in list mode', () => {
    renderToolbar()
    expect(screen.getByTestId('session-changes-toggle-view-mode')).toBeTruthy()
    expect(screen.queryByTestId('scm-title-action-sessionChanges.collapseAll')).toBeNull()
    expect(screen.queryByTestId('scm-title-action-sessionChanges.expandAll')).toBeNull()
  })

  it('shows the collapse/expand-all buttons in tree mode and clicks bump the signals', () => {
    renderToolbar()
    act(() => {
      sessionChangesViewState.setViewMode('tree')
    })

    fireEvent.click(screen.getByTestId('scm-title-action-sessionChanges.collapseAll'))
    expect(sessionChangesViewState.collapseAllSignal.get()).toBe(1)
    fireEvent.click(screen.getByTestId('scm-title-action-sessionChanges.expandAll'))
    expect(sessionChangesViewState.expandAllSignal.get()).toBe(1)
  })
})
