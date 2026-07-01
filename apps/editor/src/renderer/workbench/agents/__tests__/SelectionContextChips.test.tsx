import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { SelectionContext } from '../../../services/acp/acpSessionService.js'
import { SelectionContextChips } from '../SelectionContextChips.js'

afterEach(() => cleanup())

const CTX: SelectionContext = {
  uri: 'file:///w/src/a.ts',
  relPath: 'src/a.ts',
  text: 'const x = 1',
  startLine: 12,
  endLine: 40,
  languageId: 'typescript',
}

describe('SelectionContextChips', () => {
  it('renders nothing when there are no contexts', () => {
    const { container } = render(
      <SelectionContextChips contexts={[]} onRemove={vi.fn()} onReveal={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders a labelled chip per context and reveals on click', () => {
    const onReveal = vi.fn()
    render(<SelectionContextChips contexts={[CTX]} onRemove={vi.fn()} onReveal={onReveal} />)
    const chip = screen.getByText('src/a.ts:12-40')
    fireEvent.click(chip)
    expect(onReveal).toHaveBeenCalledWith(CTX)
  })

  it('removes on × without triggering reveal', () => {
    const onRemove = vi.fn()
    const onReveal = vi.fn()
    render(<SelectionContextChips contexts={[CTX]} onRemove={onRemove} onReveal={onReveal} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove context' }))
    expect(onRemove).toHaveBeenCalledWith(0)
    expect(onReveal).not.toHaveBeenCalled()
  })

  it('renders a single-line label without a range', () => {
    render(
      <SelectionContextChips
        contexts={[{ ...CTX, startLine: 7, endLine: 7 }]}
        onRemove={vi.fn()}
        onReveal={vi.fn()}
      />,
    )
    expect(screen.getByText('src/a.ts:7')).toBeTruthy()
  })
})
