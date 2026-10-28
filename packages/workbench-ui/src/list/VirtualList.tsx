import { useVirtualizer } from '@tanstack/react-virtual'
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ForwardedRef,
  type Key,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react'
import { useTrustedScrollElement } from './scrollElementLayout.js'

export interface VirtualListProps<T> {
  items: readonly T[]
  /**
   * Row content. By default the returned element *is* an array element, so its
   * root must carry a React `key` — nothing here supplies one, and `getItemKey`
   * is not it. Under `measureDynamically` the internal wrapper owns the key
   * instead, and the root needs none.
   */
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
  /**
   * Stable identity per index (e.g. for re-orderable lists). Defaults to the
   * index. Goes to the virtualizer only — it never becomes the React key, so
   * passing it does not relieve `renderItem` of setting one.
   */
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

type PendingScroll = {
  readonly index: number
  readonly opts: Parameters<VirtualListHandle['scrollToIndex']>[1]
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
  const resolveScrollElement = useCallback(
    (): HTMLElement | null => (scrollElementRef ? scrollElementRef.current : parentRef.current),
    [scrollElementRef],
  )

  // Dynamic measurement needs a ResizeObserver per rendered row, which only
  // makes sense for a window — so it always wins over `windowed: false`.
  const renderEveryItem = !windowed && !measureDynamically
  // Rendering every row is cheap when the list is not windowed, so the first
  // layout measurement only gates the virtual window. See scrollElementLayout.ts
  // for why a pre-layout measurement must not reach the virtualizer.
  const scrollElementReady = useTrustedScrollElement(resolveScrollElement, !renderEveryItem)
  const scrollElementReadyRef = useRef(scrollElementReady)
  scrollElementReadyRef.current = scrollElementReady
  const pendingScrollRef = useRef<PendingScroll | null>(null)

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => (scrollElementReadyRef.current ? resolveScrollElement() : null),
    // Read the element rather than assuming 0. The virtualizer seeds its offset
    // once, when it attaches, and then writes that value back to the DOM — so a
    // scroller already positioned by someone else (useScrollRestore on mount,
    // or an external scroller that outlives us) would otherwise be yanked to
    // the top the moment we attach to it. While the layout gate holds, the
    // virtual items are never read, so this is still evaluated for the first
    // time at attach — after any restore has landed.
    initialOffset: () => resolveScrollElement()?.scrollTop ?? 0,
    estimateSize,
    overscan,
    ...(getItemKey ? { getItemKey } : {}),
  })

  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex(index, opts) {
        // Before attach the virtualizer has no viewport, so this would compute
        // against an empty range. Replay it once the gate opens instead of
        // dropping it: reveal callers clear their request after issuing it.
        if (!scrollElementReadyRef.current) {
          pendingScrollRef.current = { index, opts }
          return
        }
        pendingScrollRef.current = null
        virtualizer.scrollToIndex(index, opts)
      },
      getScrollElement() {
        // Raw scroller on purpose: callers derive page sizes / scroll state from
        // it even while the layout gate holds the virtualizer back.
        return resolveScrollElement()
      },
    }),
    [virtualizer, resolveScrollElement],
  )

  // Runs on every commit (no deps) so a replay also lands if the element only
  // appears after the gate opened. The virtualizer's own layout effect is
  // registered first, so it has attached by the time this runs.
  useLayoutEffect(() => {
    if (!scrollElementReady) return
    const pending = pendingScrollRef.current
    if (!pending || resolveScrollElement() === null) return
    pendingScrollRef.current = null
    virtualizer.scrollToIndex(pending.index, pending.opts)
  })

  // Stable style refs per index — keeps renderItem children memoizable. A new
  // object is only allocated when an item's start/size actually changes.
  //
  // Offset via `top`, not `transform: translateY`. Rows are absolutely
  // positioned inside the spacer, so the two are pixel-identical — but a
  // transform is applied in the property tree, off the layout/paint-invalidation
  // path: when a row's offset changes at the same time as its content, the old
  // position's invalidation is derived from the new transform and can miss,
  // leaving the previous glyphs on screen underneath the new ones. `top` makes
  // the move an ordinary layout change, which always invalidates both rects.
  const getStableStyle = (index: number, start: number, size: number): CSSProperties => {
    const cached = styleCacheRef.current.get(index)
    if (cached && cached.start === start && cached.size === size) return cached.style
    const next: CSSProperties = {
      position: 'absolute',
      top: `${start}px`,
      left: 0,
      width: '100%',
      ...(measureDynamically ? {} : { height: `${size}px` }),
    }
    styleCacheRef.current.set(index, { start, size, style: next })
    return next
  }

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
    // Never read the virtual items while the layout gate holds: calculateRange's
    // memo dependencies call getScrollOffset(), which would freeze the
    // pre-restore scrollTop into the virtualizer's offset seed. The delayed
    // attach then writes that seed back and clobbers useScrollRestore.
    body = scrollElementReady
      ? virtualizer
          .getVirtualItems()
          .map((virtualItem) =>
            renderRow(virtualItem.index, virtualItem.start, virtualItem.size, virtualItem.key),
          )
      : null
  }

  // `flexShrink: 0` because the caller's scroller is often a flex column: a
  // shrinkable spacer would collapse to the viewport height, leaving no scroll
  // range at all.
  //
  // The spacer — not the scroller and not the rows — is what paints the opaque
  // backdrop. It has to be inside the scrolled content: a row is transparent by
  // design (it inherits the view's look), so the pixels under and around the
  // glyphs come from whatever paints below them. Chromium may raster a scroller's
  // content into a layer of its own, and when a tile there is re-rastered an
  // opaque backdrop is what overwrites the previous glyphs; without one the tile
  // keeps them and the new text lands on top of the old. Whichever surface paints
  // the background behind this list republishes `--view-background` with that
  // colour — the docked part, or an overlay that draws its own surface; anything
  // else inherits `transparent` and is unchanged. See docs/development/scroll-lists.md.
  const spacer = (
    <div
      style={{
        height: `${totalSize}px`,
        position: 'relative',
        flexShrink: 0,
        backgroundColor: 'var(--view-background, transparent)',
      }}
    >
      {body}
    </div>
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
