/*---------------------------------------------------------------------------------------------
 *  CollapseModePicker — the display-mode popover also has to answer the Vim
 *  overlay escape action: the dispatcher claims Escape on window capture ahead
 *  of AnchoredSurface, so without an `onEscape` on the list navigation the
 *  popover would stay open.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { __resetVimSurfacesForTests, getActiveVimSurface } from '@universe-editor/workbench-ui'
import { CollapseModePicker } from '../CollapseModePicker.js'

afterEach(() => {
  cleanup()
  __resetVimSurfacesForTests()
})

function renderPicker(mode: 'default' | 'collapsed' = 'default') {
  const onSelect = vi.fn()
  const onFocusInput = vi.fn()
  const utils = render(
    <CollapseModePicker mode={mode} onSelect={onSelect} onFocusInput={onFocusInput} />,
  )
  return { ...utils, onSelect, onFocusInput }
}

describe('CollapseModePicker', () => {
  it('dismisses from the Vim overlay escape action and hands focus back to the trigger', () => {
    renderPicker()
    const trigger = screen.getByTestId('acp-collapse-mode-trigger')
    fireEvent.click(trigger)
    expect(screen.getByTestId('acp-collapse-mode-popover')).toBeTruthy()

    const active = getActiveVimSurface(document)
    expect(active?.surface.kind).toBe('overlay')
    act(() => active!.surface.actions.escape?.(1))

    expect(screen.queryByTestId('acp-collapse-mode-popover')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})
