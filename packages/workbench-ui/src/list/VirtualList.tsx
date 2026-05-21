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
  className?: string
  style?: CSSProperties
  overscan?: number
}

export interface VirtualListHandle {
  scrollToIndex(index: number, opts?: { align?: 'auto' | 'start' | 'center' | 'end' }): void
}

interface CachedStyle {
  start: number
  size: number
  style: CSSProperties
}

function VirtualListInner<T>(
  { items, renderItem, estimateSize, className, style, overscan = 5 }: VirtualListProps<T>,
  ref: ForwardedRef<VirtualListHandle>,
) {
  const parentRef = useRef<HTMLDivElement>(null)
  const styleCacheRef = useRef<Map<number, CachedStyle>>(new Map())

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize,
    overscan,
  })

  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex(index, opts) {
        virtualizer.scrollToIndex(index, opts)
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
      height: `${size}px`,
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
          return renderItem(
            item,
            getStableStyle(virtualItem.index, virtualItem.start, virtualItem.size),
          )
        })}
      </div>
    </div>
  )
}

export const VirtualList = forwardRef(VirtualListInner) as <T>(
  props: VirtualListProps<T> & { ref?: Ref<VirtualListHandle> },
) => ReactElement | null
