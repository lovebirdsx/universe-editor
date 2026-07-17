import { describe, expect, it, vi } from 'vitest'
import { type ITreeDataSource } from '../ITreeDataSource.js'
import { TreeModel } from '../TreeModel.js'

interface N {
  id: string
  children?: N[]
}

/** Eager in-memory source: getChildren never returns null. */
function eagerSource(roots: N[]): ITreeDataSource<N> {
  const parent = new Map<string, N>()
  const index = (n: N, p?: N): void => {
    if (p) parent.set(n.id, p)
    n.children?.forEach((c) => index(c, n))
  }
  roots.forEach((r) => index(r))
  return {
    getId: (n) => n.id,
    hasChildren: (n) => !!n.children && n.children.length > 0,
    getChildren: (n) => n.children ?? [],
    getRoots: () => roots,
    getParent: (n) => parent.get(n.id) ?? null,
  }
}

const ids = (model: TreeModel<N>): string[] => model.getVisibleNodes().map((n) => n.id)

describe('TreeModel', () => {
  it('shows only roots until expanded', () => {
    const model = new TreeModel({
      dataSource: eagerSource([{ id: 'a', children: [{ id: 'a1' }, { id: 'a2' }] }, { id: 'b' }]),
    })
    expect(ids(model)).toEqual(['a', 'b'])
  })

  it('expand reveals children, collapse hides them', async () => {
    const root: N = { id: 'a', children: [{ id: 'a1' }, { id: 'a2' }] }
    const model = new TreeModel({ dataSource: eagerSource([root]) })
    await model.expand(root)
    expect(ids(model)).toEqual(['a', 'a1', 'a2'])
    model.collapse(root)
    expect(ids(model)).toEqual(['a'])
  })

  it('honours defaultExpanded for nodes without recorded state', () => {
    const model = new TreeModel({
      dataSource: eagerSource([{ id: 'a', children: [{ id: 'a1' }] }]),
      defaultExpanded: () => true,
    })
    expect(ids(model)).toEqual(['a', 'a1'])
  })

  it('collapses a default-expanded node on the first toggle/collapse', async () => {
    const root: N = { id: 'a', children: [{ id: 'a1' }] }
    const model = new TreeModel({ dataSource: eagerSource([root]), defaultExpanded: () => true })
    // Render once so the default-expanded state is materialised, matching the UI.
    expect(ids(model)).toEqual(['a', 'a1'])
    expect(model.isExpanded('a')).toBe(true)
    await model.toggle(root)
    expect(ids(model)).toEqual(['a'])
    model.collapse(root)
    expect(ids(model)).toEqual(['a'])
  })

  it('caches visible nodes until a structure change invalidates it', async () => {
    const root: N = { id: 'a', children: [{ id: 'a1' }] }
    const model = new TreeModel({ dataSource: eagerSource([root]) })
    const first = model.getVisibleNodes()
    expect(model.getVisibleNodes()).toBe(first)
    await model.expand(root)
    expect(model.getVisibleNodes()).not.toBe(first)
  })

  it('selection change does not rebuild the visible cache', () => {
    const model = new TreeModel({
      dataSource: eagerSource([{ id: 'a' }, { id: 'b' }]),
    })
    const first = model.getVisibleNodes()
    model.setSelection(['a'])
    expect(model.getVisibleNodes()).toBe(first)
  })

  it('awaits loadChildren on expand for a lazy source', async () => {
    const root: N = { id: 'a' }
    let loaded: N[] | null = null
    const loadChildren = vi.fn(async () => {
      loaded = [{ id: 'a1' }, { id: 'a2' }]
    })
    const source: ITreeDataSource<N> = {
      getId: (n) => n.id,
      hasChildren: () => true,
      getChildren: () => loaded,
      loadChildren,
      getRoots: () => [root],
    }
    const model = new TreeModel({ dataSource: source })
    await model.expand(root)
    expect(loadChildren).toHaveBeenCalledOnce()
    expect(ids(model)).toEqual(['a', 'a1', 'a2'])
  })

  it('selectRange selects the inclusive range in visible order', async () => {
    const root: N = { id: 'a', children: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }] }
    const model = new TreeModel({ dataSource: eagerSource([root]) })
    await model.expand(root)
    model.selectRange('a1', 'a3')
    expect([...model.selection].sort()).toEqual(['a1', 'a2', 'a3'])
    expect(model.focused).toBe('a3')
  })

  it('toggleInSelection adds then removes', () => {
    const model = new TreeModel({ dataSource: eagerSource([{ id: 'a' }, { id: 'b' }]) })
    model.toggleInSelection('a')
    expect(model.isSelected('a')).toBe(true)
    model.toggleInSelection('a')
    expect(model.isSelected('a')).toBe(false)
  })

  it('getParentNode returns the visible parent', async () => {
    const child: N = { id: 'a1' }
    const root: N = { id: 'a', children: [child] }
    const model = new TreeModel({ dataSource: eagerSource([root]) })
    await model.expand(root)
    expect(model.getParentNode('a1')?.id).toBe('a')
    expect(model.getParentNode('a')).toBeNull()
  })

  it('reveal expands ancestors, selects the target and fires onReveal', async () => {
    const leaf: N = { id: 'a1b1' }
    const root: N = { id: 'a', children: [{ id: 'a1', children: [leaf] }] }
    const model = new TreeModel({ dataSource: eagerSource([root]) })
    const onReveal = vi.fn()
    model.onReveal(onReveal)
    await model.reveal(leaf)
    expect(ids(model)).toEqual(['a', 'a1', 'a1b1'])
    expect(model.selection).toEqual(['a1b1'])
    expect(onReveal).toHaveBeenCalledWith({ id: 'a1b1' })
  })

  it('reveal fires onReveal even when the target is already the sole selection', async () => {
    const leaf: N = { id: 'a1b1' }
    const root: N = { id: 'a', children: [{ id: 'a1', children: [leaf] }] }
    const model = new TreeModel({ dataSource: eagerSource([root]) })
    await model.reveal(leaf)
    const onReveal = vi.fn()
    model.onReveal(onReveal)
    // Second reveal changes nothing about the selection, but must still fire so
    // the view can scroll a scrolled-off-screen row back into view.
    await model.reveal(leaf)
    expect(onReveal).toHaveBeenCalledWith({ id: 'a1b1' })
  })

  describe('navigate', () => {
    function tree(): TreeModel<N> {
      const model = new TreeModel({
        dataSource: eagerSource([{ id: 'a', children: [{ id: 'a1' }, { id: 'a2' }] }, { id: 'b' }]),
        defaultExpanded: () => true,
      })
      // Materialise the default-expanded state.
      expect(ids(model)).toEqual(['a', 'a1', 'a2', 'b'])
      return model
    }

    it('down/up move the selection through visible rows', () => {
      const model = tree()
      model.setSelection(['a'], 'a')
      model.navigate('down')
      expect(model.selection).toEqual(['a1'])
      model.navigate('down')
      expect(model.selection).toEqual(['a2'])
      model.navigate('up')
      expect(model.selection).toEqual(['a1'])
    })

    it('right collapsed → expands; expanded → steps into first child', () => {
      const model = tree()
      model.collapse({ id: 'a' } as N)
      model.setSelection(['a'], 'a')
      model.navigate('right')
      expect(model.isExpanded('a')).toBe(true)
      model.navigate('right')
      expect(model.selection).toEqual(['a1'])
    })

    it('left expanded → collapses; leaf/collapsed → steps to parent', () => {
      const model = tree()
      model.setSelection(['a2'], 'a2')
      model.navigate('left')
      expect(model.selection).toEqual(['a'])
      model.navigate('left')
      expect(model.isExpanded('a')).toBe(false)
    })

    it('down with extend grows the selection range', () => {
      const model = tree()
      model.setSelection(['a'], 'a')
      model.navigate('down', true)
      expect(model.selection).toEqual(['a', 'a1'])
    })

    it('is a no-op on an empty tree', () => {
      const model = new TreeModel({ dataSource: eagerSource([]) })
      model.navigate('down')
      expect(model.selection).toEqual([])
    })
  })
})
