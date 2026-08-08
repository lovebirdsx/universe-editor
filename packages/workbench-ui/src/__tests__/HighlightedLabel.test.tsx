import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { HighlightedLabel } from '../text/HighlightedLabel.js'
import highlightStyles from '../text/HighlightedLabel.module.css'

describe('HighlightedLabel', () => {
  afterEach(cleanup)

  it('renders plain text when matches are absent or empty', () => {
    const { container, rerender } = render(<HighlightedLabel text="Git: Pull" />)
    expect(container.textContent).toBe('Git: Pull')
    expect(container.querySelectorAll(`.${highlightStyles['match']}`)).toHaveLength(0)

    rerender(<HighlightedLabel text="Git: Pull" matches={[]} />)
    expect(container.textContent).toBe('Git: Pull')
    expect(container.querySelectorAll(`.${highlightStyles['match']}`)).toHaveLength(0)
  })

  it('splits text into highlighted and plain spans', () => {
    const { container } = render(
      <HighlightedLabel
        text="Git: Pull"
        matches={[
          { start: 0, end: 1 },
          { start: 5, end: 6 },
        ]}
      />,
    )
    expect(container.textContent).toBe('Git: Pull')
    const matched = Array.from(container.querySelectorAll(`.${highlightStyles['match']}`)).map(
      (el) => el.textContent,
    )
    expect(matched).toEqual(['G', 'P'])
  })

  it('highlights a trailing interval reaching the end of the text', () => {
    const { container } = render(<HighlightedLabel text="alpha" matches={[{ start: 2, end: 5 }]} />)
    expect(container.textContent).toBe('alpha')
    const matched = container.querySelector(`.${highlightStyles['match']}`)!
    expect(matched.textContent).toBe('pha')
    expect(matched.nextSibling).toBeNull()
  })

  it('tolerates out-of-bounds, inverted and overlapping intervals', () => {
    const { container } = render(
      <HighlightedLabel
        text="alpha"
        matches={[
          { start: -2, end: 2 },
          { start: 4, end: 10 },
          { start: 3, end: 3 },
          { start: 1, end: 4 },
        ]}
      />,
    )
    expect(container.textContent).toBe('alpha')
    const matched = Array.from(container.querySelectorAll(`.${highlightStyles['match']}`)).map(
      (el) => el.textContent,
    )
    expect(matched).toEqual(['alpha'])
  })
})
