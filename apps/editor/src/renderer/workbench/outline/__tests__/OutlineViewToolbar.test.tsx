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
import { OutlineViewToolbar } from '../OutlineViewToolbar.js'
import { outlineViewState } from '../outlineViewState.js'

afterEach(() => cleanup())

beforeEach(() => {
  outlineViewState.setFollowCursor(true)
  outlineViewState.setFilterOnType(true)
  outlineViewState.setSortBy('position')
  outlineViewState.setAllCollapsed(false)
})

function openOverflow(): void {
  fireEvent.click(screen.getByTitle('More Actions...'))
}

describe('OutlineViewToolbar', () => {
  it('requests collapse-all then expand-all as allCollapsed flips', () => {
    render(<OutlineViewToolbar />)

    const before = outlineViewState.collapseAllSignal.get()
    fireEvent.click(screen.getByTitle('Collapse All'))
    expect(outlineViewState.collapseAllSignal.get()).toBe(before + 1)

    // Simulate the view reporting everything is now collapsed.
    act(() => outlineViewState.setAllCollapsed(true))

    const expandBefore = outlineViewState.expandAllSignal.get()
    fireEvent.click(screen.getByTitle('Expand All'))
    expect(outlineViewState.expandAllSignal.get()).toBe(expandBefore + 1)
  })

  it('toggles Follow Cursor and Filter on Type from the overflow menu', () => {
    render(<OutlineViewToolbar />)
    openOverflow()

    fireEvent.click(screen.getByText('Follow Cursor'))
    expect(outlineViewState.followCursor.get()).toBe(false)

    fireEvent.click(screen.getByText('Filter on Type'))
    expect(outlineViewState.filterOnType.get()).toBe(false)
  })

  it('selects a sort order from the overflow menu', () => {
    render(<OutlineViewToolbar />)
    openOverflow()

    fireEvent.click(screen.getByText('Sort By: Name'))
    expect(outlineViewState.sortBy.get()).toBe('name')
  })
})
