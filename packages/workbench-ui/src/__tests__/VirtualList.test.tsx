import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
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
})
