import { useVirtualizer } from '@tanstack/react-virtual'
import {
  forwardRef,
  useImperativeHandle,
  useRef,
  type CSSProperties,
  type ForwardedRef,
  type ReactElement,
  type ReactNode,
  type Ref,
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
  }: VirtualListProps<T>,
  ref: ForwardedRef<VirtualListHandle>,
) {
  const parentRef = useRef<HTMLDivElement>(null)
  const styleCacheRef = useRef<Map<number, CachedStyle>>(new Map())

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
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
        return parentRef.current
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

  return (
    <div ref={parentRef} className={className} style={{ overflowY: 'auto', ...style }}>
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const item = items[virtualItem.index]
          if (item === undefined) return null
          const style = getStableStyle(virtualItem.index, virtualItem.start, virtualItem.size)
          if (measureDynamically) {
            return (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
                style={style}
              >
                {renderItem(item, EMPTY_STYLE)}
              </div>
            )
          }
          return renderItem(item, style)
        })}
      </div>
    </div>
  )
}

export const VirtualList = forwardRef(VirtualListInner) as <T>(
  props: VirtualListProps<T> & { ref?: Ref<VirtualListHandle> },
) => ReactElement | null
