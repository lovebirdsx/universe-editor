/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Coverage for the Perforce Graph "Get Revision…" picker: candidates come in
 *  preselected, the confirm count tracks the checked rows, and only the checked
 *  paths reach onConfirm. Cancel / backdrop / Escape all route to onCancel.
 *  Roving focus (arrows/Home/End), Space toggle, Enter confirm, and the
 *  empty-candidate explanation are covered too.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { P4GraphSyncScopeDto } from '@universe-editor/extensions-common'
import {
  PerforceGraphSyncDialog,
  type PerforceGraphSyncDialogState,
} from '../PerforceGraphSyncDialog.js'

const CANDIDATES: readonly P4GraphSyncScopeDto[] = [
  { name: 'assets', path: 'X:/p4ws/main/assets' },
  { name: 'src', path: 'X:/p4ws/main/src' },
  { name: 'tools', path: 'X:/p4ws/main/tools' },
]

function makeState(): PerforceGraphSyncDialogState {
  return { change: '4521', isLatest: true, candidates: CANDIDATES }
}

function renderDialog(state: PerforceGraphSyncDialogState = makeState()) {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  const utils = render(
    <PerforceGraphSyncDialog state={state} onConfirm={onConfirm} onCancel={onCancel} />,
  )
  return { onConfirm, onCancel, ...utils }
}

function dialogBoxes(): HTMLElement[] {
  return within(screen.getByTestId('perforceGraph-syncDialog')).getAllByRole('checkbox')
}

describe('PerforceGraphSyncDialog', () => {
  it('renders the title and candidates preselected', () => {
    renderDialog()
    const dialog = screen.getByTestId('perforceGraph-syncDialog')

    expect(within(dialog).getByText('Get Revision @4521')).toBeTruthy()
    const boxes = dialogBoxes()
    // Select-all + one row per candidate.
    expect(boxes).toHaveLength(4)
    expect(boxes.every((b) => (b as HTMLInputElement).checked)).toBe(true)
    expect(within(dialog).getByText('assets')).toBeTruthy()
    expect(within(dialog).getByText('src')).toBeTruthy()
    expect(within(dialog).getByText('tools')).toBeTruthy()
    expect(within(dialog).getByText('Get Revision (3)')).toBeTruthy()
  })

  it('updates the confirm count when a row is unchecked', () => {
    renderDialog()
    const dialog = screen.getByTestId('perforceGraph-syncDialog')
    const boxes = dialogBoxes()

    fireEvent.click(boxes[1]!)

    expect((boxes[1] as HTMLInputElement).checked).toBe(false)
    expect((boxes[0] as HTMLInputElement).checked).toBe(false)
    expect(within(dialog).getByText('Get Revision (2)')).toBeTruthy()
  })

  it('disables the confirm button once every row is unchecked', () => {
    renderDialog()
    const dialog = screen.getByTestId('perforceGraph-syncDialog')
    const boxes = dialogBoxes()

    fireEvent.click(boxes[0]!)

    const confirm = within(dialog).getByText('Get Revision (0)') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(boxes.every((b) => !(b as HTMLInputElement).checked)).toBe(true)
  })

  it('reports only the checked paths on confirm', () => {
    const { onConfirm } = renderDialog()
    const dialog = screen.getByTestId('perforceGraph-syncDialog')
    const boxes = dialogBoxes()

    fireEvent.click(boxes[1]!) // uncheck assets
    fireEvent.click(within(dialog).getByText('Get Revision (2)'))

    expect(onConfirm).toHaveBeenCalledWith(['X:/p4ws/main/src', 'X:/p4ws/main/tools'])
  })

  it('routes the Cancel button to onCancel without confirming', () => {
    const { onConfirm, onCancel } = renderDialog()
    fireEvent.click(within(screen.getByTestId('perforceGraph-syncDialog')).getByText('Cancel'))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('routes a backdrop click to onCancel', () => {
    const { onCancel } = renderDialog()
    fireEvent.click(document.querySelector('[class*="pickerBackdrop"]')!)

    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('routes Escape to onCancel', () => {
    const { onCancel } = renderDialog()
    fireEvent.keyDown(screen.getByTestId('perforceGraph-syncDialog'), { key: 'Escape' })

    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('moves focus across rows with arrow keys, Home and End', () => {
    renderDialog()
    const boxes = dialogBoxes()
    expect(document.activeElement).toBe(boxes[0])

    fireEvent.keyDown(boxes[0]!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(boxes[1])
    fireEvent.keyDown(boxes[1]!, { key: 'End' })
    expect(document.activeElement).toBe(boxes[3])
    fireEvent.keyDown(boxes[3]!, { key: 'ArrowDown' }) // clamped at the last row
    expect(document.activeElement).toBe(boxes[3])
    fireEvent.keyDown(boxes[3]!, { key: 'Home' })
    expect(document.activeElement).toBe(boxes[0])
  })

  it('toggles a row with Space', () => {
    renderDialog()
    const dialog = screen.getByTestId('perforceGraph-syncDialog')
    const boxes = dialogBoxes()

    fireEvent.keyDown(boxes[1]!, { key: ' ' })

    expect((boxes[1] as HTMLInputElement).checked).toBe(false)
    expect(within(dialog).getByText('Get Revision (2)')).toBeTruthy()
  })

  it('confirms with Enter from a row', () => {
    const { onConfirm } = renderDialog()
    const boxes = dialogBoxes()

    fireEvent.keyDown(boxes[1]!, { key: 'Enter' })

    expect(onConfirm).toHaveBeenCalledWith([
      'X:/p4ws/main/assets',
      'X:/p4ws/main/src',
      'X:/p4ws/main/tools',
    ])
  })

  it('explains itself and keeps confirm disabled when there are no candidates', () => {
    const { onConfirm } = renderDialog({ change: '4521', isLatest: false, candidates: [] })
    const dialog = screen.getByTestId('perforceGraph-syncDialog')

    expect(
      within(dialog).getByText('Could not list the workspace folders', { exact: false }),
    ).toBeTruthy()
    expect(within(dialog).queryAllByRole('checkbox')).toHaveLength(0)
    const confirm = within(dialog).getByText('Get Revision (0)') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
