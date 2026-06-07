import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PopoverList } from '../overlay/PopoverList.js'

interface Row {
  id: string
  label: string
}

const ROWS: Row[] = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
]

function renderList(props?: Partial<Parameters<typeof PopoverList<Row>>[0]>) {
  const onSelect = vi.fn()
  const onHover = vi.fn()
  render(
    <PopoverList<Row>
      items={ROWS}
      activeIndex={0}
      getKey={(r) => r.id}
      renderItem={(r) => <span>{r.label}</span>}
      onSelect={onSelect}
      onHover={onHover}
      data-testid="list"
      {...props}
    />,
  )
  return { onSelect, onHover }
}

describe('PopoverList', () => {
  afterEach(cleanup)

  it('marks the active row via aria-selected and data-active', () => {
    renderList({ activeIndex: 1 })
    const options = screen.getAllByRole('option')
    expect(options[1]!.getAttribute('aria-selected')).toBe('true')
    expect(options[0]!.getAttribute('data-active')).toBe('false')
  })

  it('selects on mousedown (preventing focus loss) and reports hover', () => {
    const { onSelect, onHover } = renderList()
    const beta = screen.getByText('Beta').closest('[role="option"]')!
    fireEvent.mouseDown(beta)
    expect(onSelect).toHaveBeenCalledWith(ROWS[1], 1)
    fireEvent.mouseEnter(beta)
    expect(onHover).toHaveBeenCalledWith(1)
  })

  it('shows emptyLabel when there are no items', () => {
    render(
      <PopoverList<Row>
        items={[]}
        activeIndex={-1}
        getKey={(r) => r.id}
        renderItem={(r) => <span>{r.label}</span>}
        onSelect={vi.fn()}
        onHover={vi.fn()}
        emptyLabel="Nothing here"
        data-testid="list"
      />,
    )
    expect(screen.getByText('Nothing here')).toBeTruthy()
    expect(screen.queryByRole('option')).toBeNull()
  })

  it('prefers loadingLabel over emptyLabel while loading and empty', () => {
    render(
      <PopoverList<Row>
        items={[]}
        activeIndex={-1}
        getKey={(r) => r.id}
        renderItem={(r) => <span>{r.label}</span>}
        onSelect={vi.fn()}
        onHover={vi.fn()}
        loading
        loadingLabel="Scanning…"
        emptyLabel="Nothing here"
        data-testid="list"
      />,
    )
    expect(screen.getByText('Scanning…')).toBeTruthy()
  })
})
