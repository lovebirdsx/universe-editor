import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ContextUsageMeter, formatTokens } from '../ContextUsageMeter.js'

describe('ContextUsageMeter', () => {
  it('renders nothing without a usable window size', () => {
    const { container, rerender } = render(<ContextUsageMeter usage={undefined} />)
    expect(container.innerHTML).toBe('')
    rerender(<ContextUsageMeter usage={{ used: 5, size: 0 }} />)
    expect(container.innerHTML).toBe('')
  })

  it('shows the percentage and toggles to raw counts on tap', () => {
    render(<ContextUsageMeter usage={{ used: 84_000, size: 200_000 }} />)
    const meter = screen.getByTestId('context-usage')
    expect(meter.textContent).toBe('42%')
    expect(meter.getAttribute('aria-label')).toContain('84k / 200k')
    expect(meter.className).not.toContain('context-usage--near')
    fireEvent.click(meter)
    expect(meter.textContent).toBe('84k/200k')
  })

  it('flags usage near the window limit', () => {
    render(<ContextUsageMeter usage={{ used: 190_000, size: 200_000 }} />)
    expect(screen.getByTestId('context-usage').className).toContain('context-usage--near')
  })

  it('formats token counts compactly', () => {
    expect(formatTokens(860)).toBe('860')
    expect(formatTokens(1_500)).toBe('1.5k')
    expect(formatTokens(84_000)).toBe('84k')
    expect(formatTokens(200_000)).toBe('200k')
    expect(formatTokens(1_000_000)).toBe('1M')
  })
})
