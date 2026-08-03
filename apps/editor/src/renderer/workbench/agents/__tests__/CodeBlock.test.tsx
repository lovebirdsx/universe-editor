/*---------------------------------------------------------------------------------------------
 *  Tests for the CodeBlock hover copy button. Rendered without a `lang` so the
 *  block takes the plain-text branch and never touches MonacoLoader.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CodeBlock } from '../CodeBlock.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function stubClipboard(writeText: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
}

describe('CodeBlock copy button', () => {
  it('copies the block code to the clipboard and flips to the copied state', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)
    render(<CodeBlock code={'const a = 1\nconst b = 2'} />)

    const button = screen.getByTestId('code-block-copy')
    fireEvent.click(button)
    await act(async () => {})

    expect(writeText).toHaveBeenCalledWith('const a = 1\nconst b = 2')
    expect(button.dataset['tooltip']).toBe('Copied')

    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(button.dataset['tooltip']).toBe('Copy code')
  })

  it('stays in the idle state when the clipboard write fails', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    stubClipboard(writeText)
    render(<CodeBlock code="x" />)

    const button = screen.getByTestId('code-block-copy')
    fireEvent.click(button)
    await act(async () => {})

    expect(button.dataset['tooltip']).toBe('Copy code')
  })
})
