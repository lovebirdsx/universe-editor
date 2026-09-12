/*---------------------------------------------------------------------------------------------
 *  Tests for the CodeBlock hover copy button. Rendered without a `lang` so the
 *  block takes the plain-text branch and never touches MonacoLoader.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CodeBlock } from '../CodeBlock.js'
import { MarkdownStreamingContext } from '../../markdown/markdownStreamingContext.js'

const mocks = vi.hoisted(() => ({ colorize: vi.fn() }))

vi.mock('../../editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: {
    ensureInitialized: () => Promise.resolve({ editor: { colorize: mocks.colorize } }),
  },
}))
vi.mock('../../editor/monaco/languageId.js', () => ({
  resolveLanguageId: () => 'typescript',
}))

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

describe('CodeBlock streaming gate', () => {
  const HIGHLIGHTED = '<span class="tok">const</span> a = 1'

  beforeEach(() => {
    mocks.colorize.mockReset()
    mocks.colorize.mockResolvedValue(HIGHLIGHTED)
  })

  const view = (streaming: boolean) => (
    <MarkdownStreamingContext.Provider value={streaming}>
      <CodeBlock code="const a = 1" lang="ts" />
    </MarkdownStreamingContext.Provider>
  )

  it('does not tokenize a fence that is still growing', async () => {
    const { container } = render(view(true))
    await act(async () => {})

    expect(mocks.colorize).not.toHaveBeenCalled()
    expect(container.querySelector('code')?.innerHTML).toBe('const a = 1')
  })

  it('tokenizes once the message seals', async () => {
    const { container } = render(view(false))
    await act(async () => {})

    expect(mocks.colorize).toHaveBeenCalledTimes(1)
    expect(container.querySelector('code')?.innerHTML).toBe(HIGHLIGHTED)
  })

  it('drops a stale highlight when a recycled instance goes back to streaming', async () => {
    // A re-seal rebuilds the node list, so this instance can end up rendering a new
    // fence; keeping the old HTML would show a shorter fence's highlight as if correct.
    const { container, rerender } = render(view(false))
    await act(async () => {})
    expect(container.querySelector('code')?.innerHTML).toBe(HIGHLIGHTED)

    rerender(view(true))
    expect(container.querySelector('code')?.innerHTML).toBe('const a = 1')
  })
})
