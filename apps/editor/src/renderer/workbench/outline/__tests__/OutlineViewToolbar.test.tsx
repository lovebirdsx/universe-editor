/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/outline/OutlineViewToolbar.tsx
 *
 *  The toolbar mirrors VSCode's outline title actions: a collapse/expand toggle
 *  whose icon and intent flip with outlineViewState.allCollapsed, and a `…`
 *  overflow menu with Follow Cursor / Filter on Type toggles plus a Sort By
 *  radio group — all wired to the shared outlineViewState.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  InstantiationService,
  ServiceCollection,
  observableValue,
  type EditorInput,
  type IEditorGroup,
} from '@universe-editor/platform'
import { ServicesContext } from '../../useService.js'
import { IEditorViewTargetService } from '../../../services/editor/EditorViewTargetService.js'
import { OutlineViewToolbar } from '../OutlineViewToolbar.js'
import { outlineViewState } from '../outlineViewState.js'

afterEach(() => cleanup())

beforeEach(() => {
  outlineViewState.setFollowCursor(true)
  outlineViewState.setFilterOnType(true)
  outlineViewState.setSortBy('position')
  outlineViewState.setAllCollapsed(false)
})

function makeGroup(id: number, isMain: boolean): IEditorGroup {
  return { id, part: { isMain } } as unknown as IEditorGroup
}

function renderToolbar(options?: { isMain?: boolean; name?: string }): void {
  const targetGroup = observableValue<IEditorGroup>(
    'test.targetGroup',
    makeGroup(1, options?.isMain ?? true),
  )
  const targetEditor = observableValue<EditorInput | undefined>(
    'test.targetEditor',
    options?.name ? ({ getName: () => options.name } as unknown as EditorInput) : undefined,
  )
  const services = new ServiceCollection()
  services.set(IEditorViewTargetService, {
    _serviceBrand: undefined,
    targetGroup,
    targetEditor,
  } as never)
  const instantiation = new InstantiationService(services)
  render(
    <ServicesContext.Provider value={instantiation}>
      <OutlineViewToolbar />
    </ServicesContext.Provider>,
  )
}

function openOverflow(): void {
  fireEvent.click(screen.getByRole('button', { name: 'More Actions...' }))
}

describe('OutlineViewToolbar', () => {
  it('shows the target badge only when following an auxiliary window editor', () => {
    renderToolbar({ isMain: true, name: 'a.ts' })
    expect(screen.queryByTestId('outline-target-badge')).toBeNull()
    cleanup()

    renderToolbar({ isMain: false, name: 'b.ts' })
    expect(screen.getByTestId('outline-target-badge')).toBeTruthy()
    expect(screen.getByText('b.ts')).toBeTruthy()
  })

  it('requests collapse-all then expand-all as allCollapsed flips', () => {
    renderToolbar()

    const before = outlineViewState.collapseAllSignal.get()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse All' }))
    expect(outlineViewState.collapseAllSignal.get()).toBe(before + 1)

    // Simulate the view reporting everything is now collapsed.
    act(() => outlineViewState.setAllCollapsed(true))

    const expandBefore = outlineViewState.expandAllSignal.get()
    fireEvent.click(screen.getByRole('button', { name: 'Expand All' }))
    expect(outlineViewState.expandAllSignal.get()).toBe(expandBefore + 1)
  })

  it('toggles Follow Cursor and Filter on Type from the overflow menu', () => {
    renderToolbar()
    openOverflow()

    fireEvent.click(screen.getByText('Follow Cursor'))
    expect(outlineViewState.followCursor.get()).toBe(false)

    fireEvent.click(screen.getByText('Filter on Type'))
    expect(outlineViewState.filterOnType.get()).toBe(false)
  })

  it('selects a sort order from the overflow menu', () => {
    renderToolbar()
    openOverflow()

    fireEvent.click(screen.getByText('Sort By: Name'))
    expect(outlineViewState.sortBy.get()).toBe('name')
  })
})
