/*---------------------------------------------------------------------------------------------
 *  useBackdropDismiss — regression test for the "drag from inside the dialog and
 *  release over the backdrop closes it" bug. Selecting text in the file dialog's
 *  path input and releasing the mouse outside the input (over the backdrop) used
 *  to dismiss the whole dialog, because the synthesized click's target is the
 *  common ancestor (the backdrop).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useBackdropDismiss } from '../overlay/useBackdropDismiss.js'

afterEach(() => cleanup())

function Backdrop({ dismiss }: { dismiss: () => void }) {
  const handlers = useBackdropDismiss(dismiss)
  return (
    <div data-testid="backdrop" {...handlers}>
      <div data-testid="dialog">
        <input data-testid="input" />
      </div>
    </div>
  )
}

describe('useBackdropDismiss', () => {
  it('dismisses when both press and release land on the backdrop', () => {
    const dismiss = vi.fn()
    const { getByTestId } = render(<Backdrop dismiss={dismiss} />)
    const backdrop = getByTestId('backdrop')

    fireEvent.mouseDown(backdrop, { target: backdrop })
    fireEvent.mouseUp(backdrop, { target: backdrop })

    expect(dismiss).toHaveBeenCalledTimes(1)
  })

  it('does NOT dismiss when the press starts inside the dialog and releases on the backdrop', () => {
    const dismiss = vi.fn()
    const { getByTestId } = render(<Backdrop dismiss={dismiss} />)
    const backdrop = getByTestId('backdrop')
    const input = getByTestId('input')

    // Press inside the input (text selection start), drag out, release over
    // the backdrop. mouseup bubbles to the backdrop with target=backdrop.
    fireEvent.mouseDown(input)
    fireEvent.mouseUp(backdrop, { target: backdrop })

    expect(dismiss).not.toHaveBeenCalled()
  })

  it('does NOT dismiss when the release lands inside the dialog', () => {
    const dismiss = vi.fn()
    const { getByTestId } = render(<Backdrop dismiss={dismiss} />)
    const backdrop = getByTestId('backdrop')
    const input = getByTestId('input')

    // Press on backdrop, drag into the dialog, release on the input.
    fireEvent.mouseDown(backdrop, { target: backdrop })
    fireEvent.mouseUp(input)

    expect(dismiss).not.toHaveBeenCalled()
  })
})
