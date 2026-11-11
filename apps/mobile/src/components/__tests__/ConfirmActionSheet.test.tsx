import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmActionSheet } from '../ConfirmActionSheet.js'
import { strings } from '../../strings.js'

function renderSheet(overrides: {
  readonly neverAskAgainLabel?: string | undefined
  readonly busy?: boolean
  readonly onConfirm?: (neverAskAgain: boolean) => void
  readonly onCancel?: () => void
}) {
  return render(
    <ConfirmActionSheet
      title="Remove?"
      body="This cannot be undone."
      confirmLabel="Remove"
      testId="confirm-sheet"
      busy={overrides.busy ?? false}
      neverAskAgainLabel={overrides.neverAskAgainLabel}
      onConfirm={overrides.onConfirm ?? vi.fn()}
      onCancel={overrides.onCancel ?? vi.fn()}
    />,
  )
}

describe('ConfirmActionSheet', () => {
  it('hides the never-ask checkbox by default and confirms with false', () => {
    const onConfirm = vi.fn()
    renderSheet({ onConfirm })

    expect(screen.queryByTestId('confirm-sheet-never-ask')).toBeNull()
    fireEvent.click(screen.getByTestId('confirm-sheet-confirm'))

    expect(onConfirm).toHaveBeenCalledWith(false)
  })

  it('reports a checked never-ask checkbox on confirm', () => {
    const onConfirm = vi.fn()
    renderSheet({ neverAskAgainLabel: strings.sessionNeverAskAgain, onConfirm })

    fireEvent.click(screen.getByTestId('confirm-sheet-never-ask'))
    fireEvent.click(screen.getByTestId('confirm-sheet-confirm'))

    expect(onConfirm).toHaveBeenCalledWith(true)
  })

  it('cancels without reporting confirmation', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    renderSheet({ neverAskAgainLabel: strings.sessionNeverAskAgain, onConfirm, onCancel })

    fireEvent.click(screen.getByTestId('confirm-sheet-never-ask'))
    fireEvent.click(screen.getByTestId('confirm-sheet-cancel'))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('disables the checkbox and confirm button while busy', () => {
    renderSheet({ neverAskAgainLabel: strings.sessionNeverAskAgain, busy: true })

    expect((screen.getByTestId('confirm-sheet-never-ask') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByTestId('confirm-sheet-confirm') as HTMLButtonElement).disabled).toBe(true)
  })

  it('starts unchecked again after the sheet is reopened', () => {
    const first = renderSheet({ neverAskAgainLabel: strings.sessionNeverAskAgain })
    fireEvent.click(screen.getByTestId('confirm-sheet-never-ask'))
    expect((screen.getByTestId('confirm-sheet-never-ask') as HTMLInputElement).checked).toBe(true)
    first.unmount()

    renderSheet({ neverAskAgainLabel: strings.sessionNeverAskAgain })

    expect((screen.getByTestId('confirm-sheet-never-ask') as HTMLInputElement).checked).toBe(false)
  })
})
