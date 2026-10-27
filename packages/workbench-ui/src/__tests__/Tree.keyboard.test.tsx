/*---------------------------------------------------------------------------------------------
 *  Tree keyboard nav — Outline's opt-in Enter behaviour:
 *   - activateNonLeafOnEnter: Enter jumps (calls onActivate) on non-leaf rows
 *     instead of toggling; expand/collapse then lives on Left/Right only.
 *  The default (off) must preserve the original Explorer behaviour: Enter
 *  toggles a non-leaf.
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
  const onActivate = vi.fn()
  render(
    <Tree<Node>
      model={model}
      onActivate={onActivate}
      renderRow={(ctx) => (
        <div
          key={ctx.node.id}
          data-row-key={ctx.node.id}
          data-selected={ctx.isSelected}
          data-expanded={ctx.node.hasChildren ? ctx.node.expanded : undefined}
          onClick={ctx.onClickRow}
        >
          {ctx.node.id}
        </div>
      )}
      {...props}
    />,
  )
  return { onActivate }
}

const view = () => screen.getByRole('tree')
const selected = () =>
  Array.from(document.querySelectorAll('[data-row-key]'))
    .filter((r) => r.getAttribute('data-selected') === 'true')
    .map((r) => r.getAttribute('data-row-key'))

describe('Tree — activateNonLeafOnEnter', () => {
  it('default: Enter toggles a non-leaf row', () => {
    const model = makeModel()
    const { onActivate } = renderTree(model)
    act(() => model.setSelection(['0'], '0'))

    fireEvent.keyDown(view(), { key: 'Enter' })
    expect(model.isExpanded('0')).toBe(false) // toggled closed
    expect(onActivate).not.toHaveBeenCalled()
    model.dispose()
  })

  it('on: Enter activates a non-leaf row without toggling it', () => {
    const model = makeModel()
    const { onActivate } = renderTree(model, { activateNonLeafOnEnter: true })
    act(() => model.setSelection(['0'], '0'))

    fireEvent.keyDown(view(), { key: 'Enter' })
    expect(model.isExpanded('0')).toBe(true) // untouched
    expect(onActivate).toHaveBeenCalledTimes(1)
    expect(onActivate.mock.calls[0]?.[0]?.id).toBe('0')
    model.dispose()
  })
})

describe('Tree — modifierActivation', () => {
  it('is off by default: Ctrl+Enter never activates', () => {
    const model = makeModel()
    const { onActivate } = renderTree(model)
    act(() => model.setSelection(['1'], '1'))

    const notPrevented = fireEvent.keyDown(view(), { key: 'Enter', ctrlKey: true })
    expect(notPrevented).toBe(true)
    expect(onActivate).not.toHaveBeenCalled()
    model.dispose()
  })

  it('routes Ctrl/Meta/Alt+Enter to onActivate with modifiers', () => {
    const model = makeModel()
    const { onActivate } = renderTree(model, { modifierActivation: true })
    act(() => model.setSelection(['1'], '1'))

    expect(fireEvent.keyDown(view(), { key: 'Enter', ctrlKey: true })).toBe(false)
    expect(fireEvent.keyDown(view(), { key: 'Enter', metaKey: true })).toBe(false)
    expect(fireEvent.keyDown(view(), { key: 'Enter', altKey: true })).toBe(false)

    expect(onActivate).toHaveBeenCalledTimes(3)
    expect(onActivate.mock.calls[0]?.[1]).toEqual({
      preview: false,
      source: 'keyboard',
      modifiers: { ctrl: true, meta: false, alt: false },
    })
    expect(onActivate.mock.calls[1]?.[1]).toEqual({
      preview: false,
      source: 'keyboard',
      modifiers: { ctrl: false, meta: true, alt: false },
    })
    expect(onActivate.mock.calls[2]?.[1]).toEqual({
      preview: false,
      source: 'keyboard',
      modifiers: { ctrl: false, meta: false, alt: true },
    })
    model.dispose()
  })

  it('activates a non-leaf row without toggling it', () => {
    const model = makeModel()
    const { onActivate } = renderTree(model, { modifierActivation: true })
    act(() => model.setSelection(['0'], '0'))

    fireEvent.keyDown(view(), { key: 'Enter', ctrlKey: true, altKey: true })
    expect(model.isExpanded('0')).toBe(true)
    expect(onActivate).toHaveBeenCalledTimes(1)
    expect(onActivate.mock.calls[0]?.[1]?.modifiers).toEqual({
      ctrl: true,
      meta: false,
      alt: true,
    })
    model.dispose()
  })

  it('leaves Ctrl+Shift+Enter to the global keybinding handler', () => {
    const model = makeModel()
    const { onActivate } = renderTree(model, { modifierActivation: true })
    act(() => model.setSelection(['1'], '1'))

    const notPrevented = fireEvent.keyDown(view(), {
      key: 'Enter',
      ctrlKey: true,
      shiftKey: true,
    })
    expect(notPrevented).toBe(true)
    expect(onActivate).not.toHaveBeenCalled()
    model.dispose()
  })

  it('keeps plain Enter and Space unchanged', () => {
    const model = makeModel()
    const { onActivate } = renderTree(model, { modifierActivation: true })
    act(() => model.setSelection(['0'], '0'))

    fireEvent.keyDown(view(), { key: 'Enter' })
    expect(model.isExpanded('0')).toBe(false)
    expect(onActivate).not.toHaveBeenCalled()

    act(() => model.setSelection(['1'], '1'))
    fireEvent.keyDown(view(), { key: ' ' })
    expect(onActivate).toHaveBeenLastCalledWith(expect.objectContaining({ id: '1' }), {
      preview: true,
      source: 'keyboard',
    })
    model.dispose()
  })

  it('reports the activation source: pointer for a click, keyboard for Space', () => {
    const model = makeModel()
    const { onActivate } = renderTree(model)

    fireEvent.click(screen.getByText('1'))
    expect(onActivate).toHaveBeenLastCalledWith(expect.objectContaining({ id: '1' }), {
      preview: true,
      source: 'pointer',
    })

    act(() => model.setSelection(['1'], '1'))
    fireEvent.keyDown(view(), { key: ' ' })
    expect(onActivate).toHaveBeenLastCalledWith(expect.objectContaining({ id: '1' }), {
      preview: true,
      source: 'keyboard',
    })
    model.dispose()
  })
})

describe('Tree — arrow navigation drives model.navigate', () => {
  it('Down/Up move selection, Right expands then descends, Left collapses then ascends', () => {
    const model = makeModel()
    renderTree(model)
    act(() => model.setSelection(['0'], '0'))

    fireEvent.keyDown(view(), { key: 'ArrowDown' })
    expect(selected()).toEqual(['0/0'])
    fireEvent.keyDown(view(), { key: 'ArrowDown' })
    expect(selected()).toEqual(['1'])
    fireEvent.keyDown(view(), { key: 'ArrowUp' })
    expect(selected()).toEqual(['0/0'])

    // Back to parent, collapse and re-expand via Left/Right.
    act(() => model.setSelection(['0'], '0'))
    fireEvent.keyDown(view(), { key: 'ArrowLeft' })
    expect(model.isExpanded('0')).toBe(false)
    fireEvent.keyDown(view(), { key: 'ArrowRight' })
    expect(model.isExpanded('0')).toBe(true)
    fireEvent.keyDown(view(), { key: 'ArrowRight' })
    expect(selected()).toEqual(['0/0'])
    fireEvent.keyDown(view(), { key: 'ArrowLeft' })
    expect(selected()).toEqual(['0'])
    model.dispose()
  })
})

describe('Tree — shift range extension', () => {
  it('keeps the original anchor across repeated Shift+ArrowDown', () => {
    const model = makeModel()
    renderTree(model)
    act(() => model.setSelection(['0'], '0'))

    fireEvent.keyDown(view(), { key: 'ArrowDown', shiftKey: true })
    fireEvent.keyDown(view(), { key: 'ArrowDown', shiftKey: true })
    expect(selected()).toEqual(['0', '0/0', '1'])
    model.dispose()
  })

  it('repeated Shift+End keeps the full range', () => {
    const model = makeModel()
    renderTree(model)
    act(() => model.setSelection(['0'], '0'))

    fireEvent.keyDown(view(), { key: 'End', shiftKey: true })
    fireEvent.keyDown(view(), { key: 'End', shiftKey: true })
    expect(selected()).toEqual(['0', '0/0', '1'])
    model.dispose()
  })

  it('Shift+ArrowUp retracts toward the anchor', () => {
    const model = makeModel()
    renderTree(model)
    act(() => model.setSelection(['0'], '0'))

    fireEvent.keyDown(view(), { key: 'ArrowDown', shiftKey: true })
    fireEvent.keyDown(view(), { key: 'ArrowDown', shiftKey: true })
    fireEvent.keyDown(view(), { key: 'ArrowUp', shiftKey: true })
    expect(selected()).toEqual(['0', '0/0'])
    fireEvent.keyDown(view(), { key: 'ArrowUp', shiftKey: true })
    expect(selected()).toEqual(['0'])
    model.dispose()
  })

  it('plain ArrowUp re-anchors after a range selection', () => {
    const model = makeModel()
    renderTree(model)
    act(() => model.setSelection(['0'], '0'))

    fireEvent.keyDown(view(), { key: 'ArrowDown', shiftKey: true })
    fireEvent.keyDown(view(), { key: 'ArrowDown', shiftKey: true })
    fireEvent.keyDown(view(), { key: 'ArrowUp' })
    fireEvent.keyDown(view(), { key: 'ArrowDown', shiftKey: true })
    expect(selected()).toEqual(['0/0', '1'])
    model.dispose()
  })

  it('built-in Shift+Click keeps the first anchor', () => {
    const model = makeModel()
    renderTree(model)
    act(() => model.setSelection(['0'], '0'))

    fireEvent.click(screen.getByText('0/0'), { shiftKey: true })
    fireEvent.click(screen.getByText('1'), { shiftKey: true })
    expect(selected()).toEqual(['0', '0/0', '1'])
    model.dispose()
  })
})
