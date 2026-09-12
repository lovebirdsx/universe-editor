/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The streaming boundary itself: which half of a growing message is treated as finished.
 *
 *  Getting this boundary wrong is invisible in the output — the same tree renders either
 *  way — so these cases pin the two things that do differ: whether a fence gets tokenized,
 *  and whether a sealed block is re-rendered at all. Re-rendering all of it per batch is
 *  what took a renderer past 2GB on 2026-09-12.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { URI } from '@universe-editor/platform'
import { MarkdownView } from '../MarkdownView.js'

const mocks = vi.hoisted(() => ({ colorize: vi.fn() }))

vi.mock('../../editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: {
    ensureInitialized: () => Promise.resolve({ editor: { colorize: mocks.colorize } }),
  },
}))
vi.mock('../../editor/monaco/languageId.js', () => ({
  resolveLanguageId: () => 'typescript',
}))

describe('the streaming boundary', () => {
  it('tokenizes a sealed fence but leaves the growing one as plain text', async () => {
    mocks.colorize.mockReset()
    mocks.colorize.mockResolvedValue('<span>sealed</span>')
    const text = 'sealed\n\n```ts\nconst a = 1\n```\n\n```ts\nconst b = 2'
    const { container } = render(<MarkdownView text={text} streaming />)
    await act(async () => {})

    // The tail is the unterminated fence; the closed one above it is on the sealed side.
    expect(mocks.colorize).toHaveBeenCalledTimes(1)
    const blocks = container.querySelectorAll('code')
    expect(blocks[0]?.innerHTML).toBe('<span>sealed</span>')
    expect(blocks[1]?.innerHTML).toBe('const b = 2')
  })

  it('does not re-render the sealed prefix while only the tail grows', () => {
    // `renderImage` is called from the render path, so a count that stops moving is the
    // memo boundary holding. The first count is asserted non-zero so the probe cannot
    // pass by never running at all.
    const renderImage = vi.fn(() => null)
    const baseUri = URI.file('X:/workspace/doc.md')
    const text = (tail: string): string => `alpha\n\n![a](a.png)\n\n${tail}`
    const { rerender } = render(
      <MarkdownView text={text('gamm')} streaming baseUri={baseUri} renderImage={renderImage} />,
    )
    const callsAfterFirst = renderImage.mock.calls.length
    expect(callsAfterFirst).toBeGreaterThan(0)

    rerender(
      <MarkdownView text={text('gamma')} streaming baseUri={baseUri} renderImage={renderImage} />,
    )

    expect(renderImage.mock.calls.length).toBe(callsAfterFirst)
  })
})
