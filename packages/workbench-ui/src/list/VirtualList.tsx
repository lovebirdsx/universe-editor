import { useVirtualizer } from '@tanstack/react-virtual'
import {
  forwardRef,
  useImperativeHandle,
  useRef,
  type CSSProperties,
  type ForwardedRef,
  type Key,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react'

export interface VirtualListProps<T> {
  items: readonly T[]
  renderItem: (item: T, style: CSSProperties) => ReactNode
  estimateSize: (index: number) => number
  className?: string | undefined
  style?: CSSProperties | undefined
  overscan?: number
  /**
   * Dynamic row heights: each rendered item is measured after mount (and on
   * resize) instead of being pinned to `estimateSize`. The positioning style is
   * owned by an internal wrapper, so `renderItem` receives a shared empty
   * style object it may ignore.
   */
  measureDynamically?: boolean
  /** Stable identity per index (e.g. for re-orderable lists). Defaults to the index. */
  getItemKey?: (index: number) => string | number
  /**
   * Scroll against an ancestor the caller owns instead of rendering our own
   * scroller. Only the spacer is emitted, so the scroll position lives on an
   * element whose identity we never change — the virtualizer attaches once and
   * never re-attaches, which matters because re-attaching resets its scroll
   * offset to 0 (`_willUpdate` ends in `_scrollToOffset(getScrollOffset())`,
   * and a fresh attach has no offset to report).
   */
  scrollElementRef?: RefObject<HTMLElement | null> | undefined
  /**
   * Render only the visible window (default). Pass false for small lists to
   * render every item — same spacer, same absolute positioning, so the DOM
   * shape does not change with the item count.
   */
  windowed?: boolean
}

export interface VirtualListHandle {
  scrollToIndex(index: number, opts?: { align?: 'auto' | 'start' | 'center' | 'end' }): void
  /** The scrollable element (this list's own scroller). Null before mount. */
  getScrollElement(): HTMLElement | null
}

interface CachedStyle {
  start: number
  size: number
  style: CSSProperties
}

// Shared style for dynamic mode: positioning lives on the measuring wrapper,
// so item roots have nothing to apply. One frozen object keeps memo intact.
const EMPTY_STYLE: CSSProperties = Object.freeze({})

function VirtualListInner<T>(
  {
    items,
    renderItem,
    estimateSize,
    className,
    style,
    overscan = 5,
    measureDynamically = false,
    getItemKey,
    scrollElementRef,
    windowed = true,
  }: VirtualListProps<T>,
  ref: ForwardedRef<VirtualListHandle>,
) {
  const parentRef = useRef<HTMLDivElement>(null)
  const styleCacheRef = useRef<Map<number, CachedStyle>>(new Map())
  const resolveScrollElement = (): HTMLElement | null =>
    scrollElementRef ? scrollElementRef.current : parentRef.current

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: resolveScrollElement,
    // Read the element rather than assuming 0. The virtualizer seeds its offset
    // once, when it attaches, and then writes that value back to the DOM — so a
    // scroller already positioned by someone else (useScrollRestore on mount,
    // or an external scroller that outlives us) would otherwise be yanked to
    // the top the moment we attach to it.
    initialOffset: () => resolveScrollElement()?.scrollTop ?? 0,
    estimateSize,
    overscan,
    ...(getItemKey ? { getItemKey } : {}),
  })

  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex(index, opts) {
        virtualizer.scrollToIndex(index, opts)
      },
      getScrollElement() {
        return resolveScrollElement()
      },
    }),
    [virtualizer],
  )

  // Stable style refs per index — keeps renderItem children memoizable. A new
  // object is only allocated when an item's start/size actually changes.
  const getStableStyle = (index: number, start: number, size: number): CSSProperties => {
    const cached = styleCacheRef.current.get(index)
    if (cached && cached.start === start && cached.size === size) return cached.style
    const next: CSSProperties = {
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      ...(measureDynamically ? {} : { height: `${size}px` }),
      transform: `translateY(${start}px)`,
    }
    styleCacheRef.current.set(index, { start, size, style: next })
    return next
  }

  // Dynamic measurement needs a ResizeObserver per rendered row, which only
  // makes sense for a window — so it always wins over `windowed: false`.
  const renderEveryItem = !windowed && !measureDynamically

  const renderRow = (index: number, start: number, size: number, key: Key) => {
    const item = items[index]
    if (item === undefined) return null
    const rowStyle = getStableStyle(index, start, size)
    if (measureDynamically) {
      return (
        <div key={key} data-index={index} ref={virtualizer.measureElement} style={rowStyle}>
          {renderItem(item, EMPTY_STYLE)}
        </div>
      )
    }
    return renderItem(item, rowStyle)
  }

  // Sized from `estimateSize` rather than `getTotalSize()` when rendering every
  // item: the virtualizer reports 0 until it has measured a scroll rect, and in
  // this mode the rows themselves are the proof of the list's extent.
  let totalSize = 0
  let body: ReactNode
  if (renderEveryItem) {
    const rows: ReactNode[] = []
    for (let index = 0; index < items.length; index++) {
      const size = estimateSize(index)
      rows.push(renderRow(index, totalSize, size, index))
      totalSize += size
    }
    body = rows
  } else {
    totalSize = virtualizer.getTotalSize()
    body = virtualizer
      .getVirtualItems()
      .map((virtualItem) =>
        renderRow(virtualItem.index, virtualItem.start, virtualItem.size, virtualItem.key),
      )
  }

  // `flexShrink: 0` because the caller's scroller is often a flex column: a
  // shrinkable spacer would collapse to the viewport height, leaving no scroll
  // range at all.
  const spacer = (
    <div style={{ height: `${totalSize}px`, position: 'relative', flexShrink: 0 }}>{body}</div>
  )

  // With an external scroller we contribute only the spacer — wrapping it in
  // our own overflow container would reintroduce the second scroll element.
  if (scrollElementRef) return spacer

  return (
    <div ref={parentRef} className={className} style={{ overflowY: 'auto', ...style }}>
      {spacer}
    </div>
  )
}

export const VirtualList = forwardRef(VirtualListInner) as <T>(
  props: VirtualListProps<T> & { ref?: Ref<VirtualListHandle> },
) => ReactElement | null
