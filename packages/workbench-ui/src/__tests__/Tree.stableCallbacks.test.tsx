/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tree.stableCallbacks — 树的回调保持同一身份，同时始终读当前渲染的 props。
 *
 *  sizeAt / makeClickHandler 不再随结构版本或视图 handler 换身份（原因见 Tree.callbackRetention），
 *  代价是必须在调用时读最新输入——冻结首帧 model / onActivate / getRowHeight 的稳定回调不会靠
 *  identity 变化暴露自己，这几个用例钉的正是这一点。
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Tree, type ITreeRowRenderContext } from '../tree/Tree.js'
import { TreeModel } from '../tree/TreeModel.js'
import type { ITreeDataSource } from '../tree/ITreeDataSource.js'

interface Node {
  id: string
}

const ROW_HEIGHT = 22
const VIEWPORT = 220

const row = (ctx: ITreeRowRenderContext<Node>) => (
  <div key={ctx.node.id} data-row-key={ctx.node.id} onClick={ctx.onClickRow} style={ctx.style}>
    {ctx.node.id}
  </div>
)

function makeModel(ids: readonly string[]): TreeModel<Node> {
  const roots: Node[] = ids.map((id) => ({ id }))
  const dataSource: ITreeDataSource<Node> = {
    getId: (n) => n.id,
    hasChildren: () => false,
    getChildren: () => [],
    getRoots: () => roots,
  }
  return new TreeModel<Node>({ dataSource })
}

const rowEl = (id: string): HTMLElement => {
  const el = document.querySelector(`[data-row-key="${id}"]`)
  if (!(el instanceof HTMLElement)) throw new Error(`行 ${id} 未渲染`)
  return el
}

afterEach(() => cleanup())

describe('Tree — stable callbacks use the latest props', () => {
  it('activates through the newest onActivate after a re-render', () => {
    const model = makeModel(['a', 'b'])
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(<Tree<Node> model={model} onActivate={first} renderRow={row} />)

    rerender(<Tree<Node> model={model} onActivate={second} renderRow={row} />)
    fireEvent.click(rowEl('b'))

    expect(second).toHaveBeenCalledTimes(1)
    expect(second.mock.calls[0]?.[0]?.id).toBe('b')
    expect(first).not.toHaveBeenCalled()
    model.dispose()
  })

  it('drives the newest model after the model prop is swapped', () => {
    const previous = makeModel(['a1', 'a2'])
    const current = makeModel(['b1', 'b2'])
    const { rerender } = render(<Tree<Node> model={previous} renderRow={row} />)

    rerender(<Tree<Node> model={current} renderRow={row} />)
    fireEvent.click(rowEl('b1'))

    expect(current.selection).toEqual(['b1'])
    expect(previous.selection).toEqual([])
    previous.dispose()
    current.dispose()
  })

  it('sizes rows from the newest getRowHeight after a re-render', () => {
    const model = makeModel(['a', 'b'])
    const { rerender } = render(<Tree<Node> model={model} rowHeight={ROW_HEIGHT} renderRow={row} />)

    expect(rowEl('b').style.height).toBe(`${ROW_HEIGHT}px`)

    rerender(
      <Tree<Node>
        model={model}
        rowHeight={ROW_HEIGHT}
        getRowHeight={(node) => (node.id === 'b' ? 40 : undefined)}
        renderRow={row}
      />,
    )

    expect(rowEl('b').style.height).toBe('40px')
    expect(rowEl('a').style.height).toBe(`${ROW_HEIGHT}px`)
    model.dispose()
  })

  it('reveals against the newest per-row heights', async () => {
    const model = makeModel(Array.from({ length: 20 }, (_, i) => `r${i}`))
    const { rerender } = render(<Tree<Node> model={model} rowHeight={ROW_HEIGHT} renderRow={row} />)
    const root = screen.getByRole('tree')
    Object.defineProperty(root, 'clientHeight', { value: VIEWPORT, configurable: true })

    rerender(
      <Tree<Node> model={model} rowHeight={ROW_HEIGHT} getRowHeight={() => 40} renderRow={row} />,
    )
    await act(async () => {
      model.setSelection(['r8'], 'r8')
    })

    // 行 8 在 40px 行高下占 [320, 360)，视口是 [0, 220) → 底对齐。
    expect(root.scrollTop).toBe(8 * 40 + 40 - VIEWPORT)
    model.dispose()
  })
})
