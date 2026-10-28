/*---------------------------------------------------------------------------------------------
 *  Tree.preLayout — Explorer's remount path: the tree root reports its content
 *  height as clientHeight until the hosting pane is laid out. The tree must not
 *  hand that number to the virtualizer (which would render every row).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { Tree } from '../tree/Tree.js'
import { TreeModel } from '../tree/TreeModel.js'
import type { ITreeDataSource } from '../tree/ITreeDataSource.js'

interface Node {
  id: string
}

const ROW_HEIGHT = 22
const NODE_COUNT = 600
const CONTENT_HEIGHT = NODE_COUNT * ROW_HEIGHT
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

function makeModel(count: number): TreeModel<Node> {
  const roots: Node[] = Array.from({ length: count }, (_, i) => ({ id: `r${i}` }))
  const dataSource: ITreeDataSource<Node> = {
    getId: (n) => n.id,
    hasChildren: () => false,
    getChildren: () => [],
    getRoots: () => roots,
  }
  return new TreeModel<Node>({ dataSource })
}

let laidOut = false
let realResizeObserver: typeof ResizeObserver | undefined
let originalClientHeight: PropertyDescriptor | undefined
let originalDocumentHeight: PropertyDescriptor | undefined

beforeEach(() => {
  laidOut = false
  realResizeObserver = globalThis.ResizeObserver
  ;(globalThis as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
  // happy-dom has no layout engine, so the realm check would always say "nothing
  // to measure". Pin a rendered document so the gate is actually exercised.
  originalDocumentHeight = Object.getOwnPropertyDescriptor(document.documentElement, 'clientHeight')
  Object.defineProperty(document.documentElement, 'clientHeight', {
    configurable: true,
    value: 768,
  })
  originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.getAttribute('role') === 'tree') return laidOut ? VIEWPORT : CONTENT_HEIGHT
      return originalClientHeight?.get?.call(this) ?? 0
    },
  })
})

afterEach(() => {
  cleanup()
  resizeCallbacks.length = 0
  if (realResizeObserver) globalThis.ResizeObserver = realResizeObserver
  if (originalClientHeight) {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight)
  }
  if (originalDocumentHeight) {
    Object.defineProperty(document.documentElement, 'clientHeight', originalDocumentHeight)
  } else {
    delete (document.documentElement as unknown as { clientHeight?: number }).clientHeight
  }
})

describe('Tree pre-layout measurement gate', () => {
  it('windows rows only after the remounted tree has a real viewport', () => {
    const { container } = render(
      <Tree<Node>
        model={makeModel(NODE_COUNT)}
        rowHeight={ROW_HEIGHT}
        renderRow={(ctx) => (
          <div key={ctx.node.id} data-row-key={ctx.node.id} style={ctx.style}>
            {ctx.node.id}
          </div>
        )}
      />,
    )

    // Pre-fix the virtualizer measured CONTENT_HEIGHT and rendered all 600 rows.
    expect(container.querySelectorAll('[data-row-key]').length).toBe(0)
    const scroller = screen.getByRole('tree')
    const spacer = scroller.firstElementChild as HTMLElement
    expect(spacer.style.height).toBe(`${CONTENT_HEIGHT}px`)

    laidOut = true
    act(() => {
      for (const cb of [...resizeCallbacks]) cb()
    })

    const rows = container.querySelectorAll('[data-row-key]').length
    expect(rows).toBeGreaterThan(0)
    expect(rows).toBeLessThan(100)
  })
})
