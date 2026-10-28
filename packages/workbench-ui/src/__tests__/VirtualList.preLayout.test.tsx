/*---------------------------------------------------------------------------------------------
 *  VirtualList.preLayout — the first layout measurement gate.
 *
 *  A view container switch remounts the view, and the pane is sized on a later
 *  layout tick. Until then a `height:100%` scroller reports its content height as
 *  `clientHeight`; handing that to the virtualizer renders every row at once.
 *  These tests pin the gate: nothing renders until the viewport is plausible,
 *  and the delayed attach must not clobber a restored scroll position.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { RefObject } from 'react'
import { VirtualList, type VirtualListHandle } from '../list/VirtualList.js'

const ROW_HEIGHT = 22
const ITEM_COUNT = 400
const CONTENT_HEIGHT = ITEM_COUNT * ROW_HEIGHT
const VIEWPORT = 660

const resizeCallbacks: Array<() => void> = []

class FakeResizeObserver {
  constructor(private readonly cb: () => void) {
    resizeCallbacks.push(this.cb)
  }
  observe() {}
  unobserve() {}
  disconnect() {
    const i = resizeCallbacks.indexOf(this.cb)
    if (i !== -1) resizeCallbacks.splice(i, 1)
  }
}

let realResizeObserver: typeof ResizeObserver | undefined
let originalDocumentHeight: PropertyDescriptor | undefined

beforeEach(() => {
  realResizeObserver = globalThis.ResizeObserver
  ;(globalThis as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
  // happy-dom has no layout engine, so the realm check would always say "nothing
  // to measure". Pin a rendered document so the gate is actually exercised.
  originalDocumentHeight = Object.getOwnPropertyDescriptor(document.documentElement, 'clientHeight')
  Object.defineProperty(document.documentElement, 'clientHeight', {
    configurable: true,
    value: 768,
  })
})

afterEach(() => {
  cleanup()
  resizeCallbacks.length = 0
  if (realResizeObserver) globalThis.ResizeObserver = realResizeObserver
  if (originalDocumentHeight) {
    Object.defineProperty(document.documentElement, 'clientHeight', originalDocumentHeight)
  } else {
    delete (document.documentElement as unknown as { clientHeight?: number }).clientHeight
  }
})

const items = Array.from({ length: ITEM_COUNT }, (_, i) => `i${i}`)

function makeScroller(initialHeight: number) {
  const scroller = document.createElement('div')
  let height = initialHeight
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => height })
  Object.defineProperty(scroller, 'scrollHeight', {
    configurable: true,
    get: () => CONTENT_HEIGHT,
  })
  return {
    scroller,
    setHeight(next: number) {
      height = next
    },
  }
}

interface RenderOptions {
  readonly windowed?: boolean
  readonly handle?: RefObject<VirtualListHandle | null>
}

function listElement(scrollElementRef: RefObject<HTMLElement | null>, options: RenderOptions) {
  return (
    <VirtualList
      {...(options.handle ? { ref: options.handle } : {})}
      items={items}
      estimateSize={() => ROW_HEIGHT}
      scrollElementRef={scrollElementRef}
      windowed={options.windowed ?? true}
      renderItem={(item, style) => (
        <div key={item} data-row style={style}>
          {item}
        </div>
      )}
    />
  )
}

function renderList(scroller: HTMLElement, options: RenderOptions = {}) {
  // One ref object for the whole test: a fresh object would change
  // `resolveScrollElement`'s identity and restart the gate on every rerender.
  const scrollElementRef: RefObject<HTMLElement | null> = { current: scroller }
  const view = render(listElement(scrollElementRef, options))
  const rows = (): NodeListOf<HTMLElement> => view.container.querySelectorAll('[data-row]')
  const spacer = (): HTMLElement => view.container.firstElementChild as HTMLElement
  return {
    ...view,
    rows,
    spacer,
    rerender: (next: RenderOptions): void => {
      view.rerender(listElement(scrollElementRef, next))
    },
  }
}

const fireResize = (): void => {
  act(() => {
    for (const cb of [...resizeCallbacks]) cb()
  })
}

describe('VirtualList pre-layout measurement gate', () => {
  it('renders nothing until the scroller reports a real viewport', () => {
    const { scroller, setHeight } = makeScroller(CONTENT_HEIGHT)
    const { rows, spacer } = renderList(scroller)

    // Pre-fix the virtualizer would have measured CONTENT_HEIGHT and rendered
    // every one of the 400 rows.
    expect(rows().length).toBe(0)
    expect(spacer().style.height).toBe(`${CONTENT_HEIGHT}px`)

    setHeight(VIEWPORT)
    fireResize()

    expect(rows().length).toBeGreaterThan(0)
    expect(rows().length).toBeLessThan(100)
  })

  it('keeps a scroll position set while the gate holds', () => {
    const { scroller, setHeight } = makeScroller(CONTENT_HEIGHT)
    renderList(scroller)

    scroller.scrollTop = 500
    setHeight(VIEWPORT)
    fireResize()

    // If the gate read the virtual items early it would have seeded offset 0,
    // and the delayed attach would write that seed back over the live position.
    expect(scroller.scrollTop).toBe(500)
  })

  it('attaches synchronously when the scroller is already laid out', () => {
    const { scroller } = makeScroller(VIEWPORT)
    const { rows } = renderList(scroller)

    expect(rows().length).toBeGreaterThan(0)
    expect(rows().length).toBeLessThan(100)
  })

  it('exposes the raw scroller through the handle while the gate holds', () => {
    const { scroller } = makeScroller(CONTENT_HEIGHT)
    const handle: RefObject<VirtualListHandle | null> = { current: null }
    renderList(scroller, { handle })

    // useScrollRestore and page-size callers read the scroller before the
    // virtualizer attaches; returning null here would silently disable them.
    expect(handle.current?.getScrollElement()).toBe(scroller)
  })

  it('replays a scrollToIndex issued while the gate holds', () => {
    const { scroller, setHeight } = makeScroller(CONTENT_HEIGHT)
    const handle: RefObject<VirtualListHandle | null> = { current: null }
    const { rows } = renderList(scroller, { handle })
    expect(rows().length).toBe(0)

    act(() => {
      handle.current?.scrollToIndex(300)
    })
    expect(scroller.scrollTop).toBe(0)

    setHeight(VIEWPORT)
    fireResize()

    // A reveal issued before the first attach must not be consumed without
    // scrolling: it is replayed once the virtualizer has a viewport.
    expect(rows().length).toBeGreaterThan(0)
    expect(scroller.scrollTop).toBeGreaterThan(0)
  })

  it('gates the first windowed render after a non-windowed mount in a pre-layout pane', () => {
    const { scroller, setHeight } = makeScroller(CONTENT_HEIGHT)
    const { rows, rerender } = renderList(scroller, { windowed: false })
    // Below the threshold every row is rendered; the virtualizer attached while
    // the pane still reported its content height.
    expect(rows().length).toBe(ITEM_COUNT)

    rerender({ windowed: true })
    // Crossing the threshold must not reuse that pre-layout measurement.
    expect(rows().length).toBe(0)

    setHeight(VIEWPORT)
    fireResize()

    expect(rows().length).toBeGreaterThan(0)
    expect(rows().length).toBeLessThan(100)
  })
})
