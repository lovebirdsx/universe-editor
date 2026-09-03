/*---------------------------------------------------------------------------------------------
 *  Tree keyboard context menu — ContextMenu key / Shift+F10 must open the menu
 *  anchored at the focused row (VSCode parity), not at the browser's synthetic
 *  (0,0) coordinates.
 *
 *  happy-dom has no layout engine, so the row rect is pinned via a
 *  getBoundingClientRect mock; the test locks the fix at its source: the
 *  dispatched contextmenu event carries coordinates derived from the row rect.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Tree } from '../tree/Tree.js'
import { TreeModel } from '../tree/TreeModel.js'
import type { ITreeDataSource } from '../tree/ITreeDataSource.js'

afterEach(() => cleanup())

interface Node {
  id: string
  children: Node[]
}

function makeModel(): TreeModel<Node> {
  const child: Node = { id: '0/0', children: [] }
  const parent: Node = { id: '0', children: [child] }
  const tail: Node = { id: '1', children: [] }
  const roots: Node[] = [parent, tail]
  const byId = new Map<string, Node>([
    ['0', parent],
    ['0/0', child],
    ['1', tail],
  ])
  const dataSource: ITreeDataSource<Node> = {
    getId: (n) => n.id,
    hasChildren: (n) => n.children.length > 0,
    getChildren: (n) => n.children,
    getRoots: () => roots,
    getParent: (n) => {
      const slash = n.id.lastIndexOf('/')
      return slash < 0 ? null : (byId.get(n.id.slice(0, slash)) ?? null)
    },
  }
  return new TreeModel<Node>({ dataSource, defaultExpanded: () => true })
}

function renderTree(model: TreeModel<Node>, props: Partial<Parameters<typeof Tree<Node>>[0]> = {}) {
  const rowMenu = vi.fn()
  render(
    <Tree<Node>
      model={model}
      renderRow={(ctx) => (
        <div key={ctx.node.id} data-row-key={ctx.node.id} onContextMenu={rowMenu}>
          {ctx.node.id}
        </div>
      )}
      {...props}
    />,
  )
  return { rowMenu }
}

const view = () => screen.getByRole('tree')

const pinRowRect = (id: string, left: number, top: number, width: number, height: number) => {
  const row = document.querySelector<HTMLElement>(`[data-row-key="${id}"]`)
  expect(row).not.toBeNull()
  const rect = new DOMRect(left, top, width, height)
  vi.spyOn(row as HTMLElement, 'getBoundingClientRect').mockReturnValue(rect)
  return row as HTMLElement
}

describe('Tree — keyboard context menu anchors to the focused row', () => {
  it('ContextMenu key dispatches a contextmenu at the focused row rect', () => {
    const model = makeModel()
    const { rowMenu } = renderTree(model)
    act(() => model.setSelection(['0'], '0'))

    pinRowRect('0', 100, 40, 200, 22)
    fireEvent.keyDown(view(), { key: 'ContextMenu' })

    expect(rowMenu).toHaveBeenCalledTimes(1)
    const event = rowMenu.mock.calls[0]?.[0] as MouseEvent | undefined
    expect(event?.clientX).toBe(100)
    expect(event?.clientY).toBe(62) // row bottom — menu opens below the row
    model.dispose()
  })

  it('Shift+F10 behaves like the ContextMenu key', () => {
    const model = makeModel()
    const { rowMenu } = renderTree(model)
    act(() => model.setSelection(['0/0'], '0/0'))

    pinRowRect('0/0', 30, 10, 100, 22)
    fireEvent.keyDown(view(), { key: 'F10', shiftKey: true })

    expect(rowMenu).toHaveBeenCalledTimes(1)
    const event = rowMenu.mock.calls[0]?.[0] as MouseEvent | undefined
    expect(event?.clientX).toBe(30)
    expect(event?.clientY).toBe(32)
    model.dispose()
  })

  it('plain F10 is left to the browser', () => {
    const model = makeModel()
    const { rowMenu } = renderTree(model)
    act(() => model.setSelection(['0'], '0'))

    fireEvent.keyDown(view(), { key: 'F10' })

    expect(rowMenu).not.toHaveBeenCalled()
    model.dispose()
  })

  it('without a focused row it dispatches on the container at its top-left', () => {
    const model = makeModel()
    const emptyMenu = vi.fn()
    renderTree(model, { onContextMenu: emptyMenu })

    const container = view()
    const rect = new DOMRect(5, 7, 300, 400)
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(rect)
    fireEvent.keyDown(container, { key: 'ContextMenu' })

    expect(emptyMenu).toHaveBeenCalledTimes(1)
    const event = emptyMenu.mock.calls[0]?.[0] as MouseEvent | undefined
    expect(emptyMenu.mock.calls[0]?.[1]).toBeNull()
    expect(event?.clientX).toBe(5)
    expect(event?.clientY).toBe(7)
    model.dispose()
  })

  it('mouse right-click on the empty area keeps the pointer coordinates', () => {
    const model = makeModel()
    const emptyMenu = vi.fn()
    renderTree(model, { onContextMenu: emptyMenu })

    // detail 1 = a real mouse right-click (keyboard-generated events carry 0).
    fireEvent.contextMenu(view(), { clientX: 11, clientY: 13, detail: 1 })

    expect(emptyMenu).toHaveBeenCalledTimes(1)
    const event = emptyMenu.mock.calls[0]?.[0] as MouseEvent | undefined
    expect(emptyMenu.mock.calls[0]?.[1]).toBeNull()
    expect(event?.clientX).toBe(11)
    expect(event?.clientY).toBe(13)
    model.dispose()
  })

  it('keyup-supplemented native contextmenu does not open a second menu', () => {
    const model = makeModel()
    const containerMenu = vi.fn()
    const rowMenu = vi.fn()
    // The real row chain (ExplorerTreeNode → ExplorerView.onRowContextMenu) stops
    // propagation, so the row menu owns the event end to end.
    render(
      <Tree<Node>
        model={model}
        onContextMenu={containerMenu}
        renderRow={(ctx) => (
          <div
            key={ctx.node.id}
            data-row-key={ctx.node.id}
            onContextMenu={(e) => {
              e.stopPropagation()
              rowMenu(e)
            }}
          >
            {ctx.node.id}
          </div>
        )}
      />,
    )
    act(() => model.setSelection(['0'], '0'))

    pinRowRect('0', 100, 40, 200, 22)
    fireEvent.keyDown(view(), { key: 'ContextMenu' })
    // Chromium supplements the ContextMenu key press with a native contextmenu
    // on keyup — targeted at the DOM-focus holder (the tree container), at (0,0)
    // coordinates and detail 0 (UI Events: keyboard-generated mouse events carry
    // detail 0). keydown's preventDefault cannot cancel it.
    fireEvent.contextMenu(view(), { detail: 0, clientX: 0, clientY: 0 })

    expect(rowMenu).toHaveBeenCalledTimes(1)
    // The keyboard-dispatched event must look mouse-like so the container's
    // detail-0 guard doesn't swallow it when it bubbles past a row handler.
    expect((rowMenu.mock.calls[0]?.[0] as MouseEvent | undefined)?.detail).toBe(1)
    expect(containerMenu).not.toHaveBeenCalled()
    model.dispose()
  })
})
