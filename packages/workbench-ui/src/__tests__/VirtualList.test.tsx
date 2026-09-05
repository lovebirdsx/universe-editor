import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { useLayoutEffect, useRef, useState } from 'react'
import { VirtualList } from '../list/VirtualList.js'

// happy-dom has no layout engine so @tanstack/react-virtual renders 0 visible items
// (ResizeObserver never fires, container height stays 0). Tests verify the stable
// structural contract: outer container style/className and the spacer's total height.

describe('VirtualList', () => {
  it('renders spacer with correct total height for item count × estimateSize', () => {
    const items = ['a', 'b', 'c']
    const { container } = render(
      <VirtualList
        items={items}
        renderItem={(item, style) => (
          <div key={item} style={style}>
            {item}
          </div>
        )}
        estimateSize={() => 22}
      />,
    )
    // Outer scroll div
    const outer = container.firstElementChild as HTMLElement
    expect(outer).toBeDefined()
    expect(outer.style.overflowY).toBe('auto')

    // Inner spacer div must reflect total size = 3 × 22 = 66px
    const spacer = outer.firstElementChild as HTMLElement
    expect(spacer).toBeDefined()
    expect(spacer.style.height).toBe('66px')
    expect(spacer.style.position).toBe('relative')
  })

  it('renders empty list without crash', () => {
    const { container } = render(
      <VirtualList items={[]} renderItem={() => null} estimateSize={() => 22} />,
    )
    expect(container).toBeDefined()
    const spacer = container.firstElementChild?.firstElementChild as HTMLElement | undefined
    expect(spacer?.style.height).toBe('0px')
  })

  it('spacer height scales with estimateSize', () => {
    const items = ['x']
    const { container } = render(
      <VirtualList
        items={items}
        renderItem={(item, style) => (
          <div key={item} style={style}>
            {item}
          </div>
        )}
        estimateSize={() => 30}
      />,
    )
    const spacer = container.firstElementChild?.firstElementChild as HTMLElement
    expect(spacer.style.height).toBe('30px')
  })

  it('passes className to outer container', () => {
    const { container } = render(
      <VirtualList
        items={['a']}
        renderItem={(item, style) => (
          <div key={item} style={style}>
            {item}
          </div>
        )}
        estimateSize={() => 22}
        className="my-list"
      />,
    )
    expect(container.firstElementChild?.classList.contains('my-list')).toBe(true)
  })

  it('contributes only the spacer when given an external scroll element', () => {
    // Tree relies on this: a second scroller nested inside the caller's would
    // be the element React unmounts on a re-render, taking the position with it.
    function Host() {
      const ref = useRef<HTMLDivElement>(null)
      return (
        <div ref={ref} data-testid="scroller" style={{ overflowY: 'auto' }}>
          <VirtualList
            items={['a', 'b']}
            renderItem={(item, style) => (
              <div key={item} style={style}>
                {item}
              </div>
            )}
            estimateSize={() => 22}
            scrollElementRef={ref}
          />
        </div>
      )
    }
    const { container } = render(<Host />)

    const host = container.firstElementChild as HTMLElement
    const spacer = host.firstElementChild as HTMLElement
    expect(spacer.style.height).toBe('44px')
    expect(spacer.style.position).toBe('relative')
    // No wrapper of our own, and nothing inside scrolls independently.
    expect(spacer.style.overflowY).toBe('')
    expect(host.querySelectorAll('[style*="overflow"]').length).toBe(0)
  })

  it('renders every item when windowing is off', () => {
    // The windowed path renders ~0 rows here (no layout engine), so this is what
    // keeps small lists queryable in tests and reachable for find-in-page.
    const items = Array.from({ length: 50 }, (_, i) => `i${i}`)
    const { container } = render(
      <VirtualList
        items={items}
        renderItem={(item, style) => (
          <div key={item} data-row style={style}>
            {item}
          </div>
        )}
        estimateSize={() => 22}
        windowed={false}
      />,
    )

    const rows = container.querySelectorAll('[data-row]')
    expect(rows.length).toBe(50)
    // Positioning matches the windowed path exactly — same spacer, same offsets.
    expect((rows[3] as HTMLElement).style.transform).toBe('translateY(66px)')
    const spacer = container.firstElementChild?.firstElementChild as HTMLElement
    expect(spacer.style.height).toBe('1100px')
  })

  it('adopts the scroll element position it attaches to instead of resetting it', () => {
    // The virtualizer seeds its offset the first time it renders and then writes
    // that value back to the DOM. Seeding from 0 would undo a position set by
    // whoever owns the scroller — useScrollRestore writes one in a layout effect,
    // before the list is mounted. Callers gate the list on the container being
    // there (Tree's `containerReady`), so the seed reads a real element.
    function Host() {
      const ref = useRef<HTMLDivElement>(null)
      const [ready, setReady] = useState(false)
      useLayoutEffect(() => {
        if (!ref.current) return
        ref.current.scrollTop = 120
        setReady(true)
      }, [])
      return (
        <div ref={ref} style={{ overflowY: 'auto' }}>
          {ready && (
            <VirtualList
              items={Array.from({ length: 100 }, (_, i) => `i${i}`)}
              renderItem={(item, style) => (
                <div key={item} style={style}>
                  {item}
                </div>
              )}
              estimateSize={() => 22}
              scrollElementRef={ref}
            />
          )}
        </div>
      )
    }
    const { container } = render(<Host />)

    expect((container.firstElementChild as HTMLElement).scrollTop).toBe(120)
  })
})
