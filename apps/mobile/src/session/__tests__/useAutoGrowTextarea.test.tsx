import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { clampAutoGrowHeight, useAutoGrowTextarea } from '../useAutoGrowTextarea.js'

function Probe({ value, maxHeightPx }: { value: string; maxHeightPx: number }) {
  const ref = useAutoGrowTextarea(value, { maxHeightPx })
  return <textarea ref={ref} data-testid="probe" value={value} readOnly />
}

function probe(): HTMLTextAreaElement {
  return screen.getByTestId('probe') as HTMLTextAreaElement
}

function stubScrollHeight(element: HTMLTextAreaElement, value: number): void {
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value })
}

describe('clampAutoGrowHeight', () => {
  it('adds the border height and clamps at the ceiling', () => {
    expect(clampAutoGrowHeight(40, 2, 164)).toBe(42)
    expect(clampAutoGrowHeight(400, 2, 164)).toBe(164)
  })
})

describe('useAutoGrowTextarea', () => {
  it('sizes to the content and stops at maxHeightPx', () => {
    const view = render(<Probe value="" maxHeightPx={164} />)
    const input = probe()

    stubScrollHeight(input, 80)
    view.rerender(<Probe value={'two\nlines'} maxHeightPx={164} />)
    expect(input.style.height).toBe('80px')

    stubScrollHeight(input, 400)
    view.rerender(<Probe value={'many\nlines'} maxHeightPx={164} />)
    expect(input.style.height).toBe('164px')
  })

  it('re-measures when the window resizes', () => {
    render(<Probe value="" maxHeightPx={164} />)
    const input = probe()

    stubScrollHeight(input, 120)
    window.dispatchEvent(new Event('resize'))
    expect(input.style.height).toBe('120px')
  })

  it('keeps a focused textarea in view after resizing', () => {
    const view = render(<Probe value="" maxHeightPx={164} />)
    const input = probe()
    const scrollIntoView = vi.fn()
    input.scrollIntoView = scrollIntoView
    input.focus()

    stubScrollHeight(input, 90)
    view.rerender(<Probe value="line" maxHeightPx={164} />)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('does not scroll while unfocused', () => {
    const view = render(<Probe value="" maxHeightPx={164} />)
    const input = probe()
    const scrollIntoView = vi.fn()
    input.scrollIntoView = scrollIntoView

    stubScrollHeight(input, 90)
    view.rerender(<Probe value="line" maxHeightPx={164} />)
    expect(scrollIntoView).not.toHaveBeenCalled()
  })
})
