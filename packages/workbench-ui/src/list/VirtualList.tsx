import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef, type CSSProperties, type ReactNode } from 'react'

export interface VirtualListProps<T> {
  items: readonly T[]
  renderItem: (item: T, style: CSSProperties) => ReactNode
  estimateSize: (index: number) => number
  className?: string
  style?: CSSProperties
  overscan?: number
}

export function VirtualList<T>({
  items,
  renderItem,
  estimateSize,
  className,
  style,
  overscan = 5,
}: VirtualListProps<T>) {
  const parentRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize,
    overscan,
  })

  return (
    <div ref={parentRef} className={className} style={{ overflowY: 'auto', ...style }}>
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const item = items[virtualItem.index]
          if (item === undefined) return null
          return renderItem(item, {
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: `${virtualItem.size}px`,
            transform: `translateY(${virtualItem.start}px)`,
          })
        })}
      </div>
    </div>
  )
}
