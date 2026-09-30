/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for ToolCallLocations — the rows must report the modifier the user held,
 *  since the opener (useMarkdownFileLink) is what decides whether the file opens
 *  beside the chat or over it.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ToolCallLocations } from '../ToolCallLocations.js'

afterEach(() => {
  cleanup()
})

describe('ToolCallLocations', () => {
  const location = { path: '/repo/src/a.ts', line: 3 }

  it('forwards the Ctrl/Cmd modifier held on a row to the opener', () => {
    const onOpen = vi.fn()
    render(<ToolCallLocations locations={[location]} onOpen={onOpen} />)
    const row = screen.getByTestId('acp-toolcall-location')

    fireEvent.click(row, { ctrlKey: true })
    expect(onOpen).toHaveBeenLastCalledWith(location, { toSide: true })

    fireEvent.click(row, { metaKey: true })
    expect(onOpen).toHaveBeenLastCalledWith(location, { toSide: true })

    fireEvent.click(row)
    expect(onOpen).toHaveBeenLastCalledWith(location, { toSide: false })
  })
})
