import { describe, expect, it } from 'vitest'
import type { DragEvent } from 'react'
import { resourceDragProps, selectionDragUris } from '../dnd/resourceDrag.js'

function makeDataTransfer(): DataTransfer {
  const store = new Map<string, string>()
  return {
    effectAllowed: 'none',
    setData: (type: string, value: string) => store.set(type, value),
    getData: (type: string) => store.get(type) ?? '',
    get types() {
      return Array.from(store.keys())
    },
  } as unknown as DataTransfer
}

describe('selectionDragUris', () => {
  it('drags the whole selection when it includes self and has more than one item', () => {
    expect(selectionDragUris('b', ['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('drags only self when self is not part of the selection', () => {
    expect(selectionDragUris('z', ['a', 'b'])).toEqual(['z'])
  })

  it('drags only self for a single-item selection', () => {
    expect(selectionDragUris('a', ['a'])).toEqual(['a'])
  })

  it('drags only self when no selection is given', () => {
    expect(selectionDragUris('a')).toEqual(['a'])
  })
})

describe('resourceDragProps', () => {
  it('writes text/uri-list on dragstart and marks the element draggable', () => {
    const props = resourceDragProps(() => ['file:///a.ts', 'file:///b.ts'])
    expect(props.draggable).toBe(true)

    const dt = makeDataTransfer()
    props.onDragStart({ dataTransfer: dt } as unknown as DragEvent)
    expect(dt.getData('text/uri-list')).toBe('file:///a.ts\r\nfile:///b.ts')
    expect(dt.effectAllowed).toBe('all')
  })

  it('no-ops without a dataTransfer', () => {
    const props = resourceDragProps(() => ['file:///a.ts'])
    expect(() => props.onDragStart({ dataTransfer: null } as unknown as DragEvent)).not.toThrow()
  })
})
