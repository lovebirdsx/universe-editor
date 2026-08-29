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

  describe('default-expanded lazy nodes', () => {
    function lazySource(loadedById: Map<string, N[] | null>) {
      const roots: N[] = []
      // Defer the cache write like a real async pull (RPC) — a body that sets
      // synchronously makes the collect pass observe children immediately.
      const loadChildren = vi.fn((n: N) =>
        Promise.resolve().then(() => {
          loadedById.set(n.id, n.children ?? [])
        }),
      )
      const source: ITreeDataSource<N> = {
        getId: (n) => n.id,
        hasChildren: (n) => n.children !== undefined,
        getChildren: (n) => (loadedById.has(n.id) ? loadedById.get(n.id)! : null),
        loadChildren,
        getRoots: () => [...roots],
      }
      return { source, loadChildren, roots }
    }

    it('pulls children when a default-expanded node first becomes visible', async () => {
      const { source, loadChildren, roots } = lazySource(new Map())
      roots.push({ id: 'a', children: [{ id: 'a1' }] })
      const model = new TreeModel({ dataSource: source, defaultExpanded: () => true })
      const structures = vi.fn()
      model.onDidChangeStructure(structures)

      // First render: expanded shell, no children yet — but the pull is on its way.
      expect(ids(model)).toEqual(['a'])
      expect(loadChildren).toHaveBeenCalledOnce()
      await vi.waitFor(() => expect(ids(model)).toEqual(['a', 'a1']))
      expect(structures).toHaveBeenCalledOnce() // one notification, when the pull landed
    })

    it('cascades through nested default-expanded levels', async () => {
      const { source, loadChildren, roots } = lazySource(new Map())
      roots.push({ id: 'a', children: [{ id: 'a1', children: [{ id: 'a1b' }] }] })
      const model = new TreeModel({ dataSource: source, defaultExpanded: () => true })
      expect(ids(model)).toEqual(['a'])
      await vi.waitFor(() => expect(ids(model)).toEqual(['a', 'a1', 'a1b']))
      expect(loadChildren).toHaveBeenCalledTimes(2)
    })

    it('does not fire onDidChangeExpansion for the default-expansion pull', async () => {
      const { source, roots } = lazySource(new Map())
      roots.push({ id: 'a', children: [{ id: 'a1' }] })
      const model = new TreeModel({ dataSource: source, defaultExpanded: () => true })
      const expansions = vi.fn()
      model.onDidChangeExpansion(expansions)
      expect(ids(model)).toEqual(['a'])
      await vi.waitFor(() => expect(ids(model)).toEqual(['a', 'a1']))
      expect(expansions).not.toHaveBeenCalled()
    })

    it('surfaces a failed default-expansion pull as the row error and does not retry per render', async () => {
      const loadedById = new Map<string, N[] | null>()
      const loadChildren = vi.fn(async () => {
        throw new Error('fetch exploded')
      })
      const roots: N[] = [{ id: 'a', children: [{ id: 'a1' }] }]
      const source: ITreeDataSource<N> = {
        getId: (n) => n.id,
        hasChildren: () => true,
        getChildren: (n) => (loadedById.has(n.id) ? loadedById.get(n.id)! : null),
        loadChildren,
        getRoots: () => roots,
      }
      const model = new TreeModel({ dataSource: source, defaultExpanded: () => true })
      expect(ids(model)).toEqual(['a'])
      await vi.waitFor(() => expect(model.getVisibleNodes()[0]!.error).toBe('fetch exploded'))
      model.getVisibleNodes()
      model.getVisibleNodes()
      expect(loadChildren).toHaveBeenCalledOnce()
      // Collapse → re-expand retries through the explicit expand path.
      model.collapse(roots[0]!)
      await model.expand(roots[0]!)
      expect(loadChildren).toHaveBeenCalledTimes(2)
    })
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

  describe('getCollapsedIds', () => {
    const foldingModel = () => {
      const roots: N[] = [
        { id: 'a', children: [{ id: 'a1' }] },
        { id: 'b', children: [{ id: 'b1' }] },
      ]
      return {
        roots,
        model: new TreeModel({ dataSource: eagerSource(roots), defaultExpanded: () => true }),
      }
    }

    it('starts empty: default-expanded nodes are not a diff', () => {
      const { model } = foldingModel()
      model.getVisibleNodes() // materialise default-expanded states
      expect(model.getCollapsedIds()).toEqual([])
    })

    it('lists user-collapsed nodes and drops them again on re-expand', async () => {
      const { model, roots } = foldingModel()
      model.getVisibleNodes()
      model.collapse(roots[0]!)
      expect(model.getCollapsedIds()).toEqual(['a'])
      await model.expand(roots[0]!)
      expect(model.getCollapsedIds()).toEqual([])
    })

    it('round-trips through setExpansion on a fresh model', () => {
      const { model: first, roots } = foldingModel()
      first.getVisibleNodes()
      first.collapse(roots[0]!)
      first.collapse(roots[1]!)
      const persisted = first.getCollapsedIds()
      expect([...persisted].sort()).toEqual(['a', 'b'])

      const { model: second } = foldingModel()
      second.setExpansion(persisted.map((id) => [id, false] as const))
      expect(second.isExpanded('a')).toBe(false)
      expect(second.isExpanded('b')).toBe(false)
      expect(ids(second)).toEqual(['a', 'b']) // collapsed — children stay hidden
    })
  })

  describe('setExpansionAndRefresh', () => {
    const counting = (model: TreeModel<N>): (() => number) => {
      let count = 0
      model.onDidChangeStructure(() => count++)
      return () => count
    }
    const sample = (): N[] => [
      { id: 'a', children: [{ id: 'a1' }, { id: 'a2' }] },
      { id: 'b', children: [{ id: 'b1' }] },
    ]

    it('applies a batch of updates in a single structure event', () => {
      const model = new TreeModel({ dataSource: eagerSource(sample()) })
      const structures = counting(model)

      model.setExpansionAndRefresh([
        ['a', true],
        ['b', false],
      ])

      expect(structures()).toBe(1)
      expect(model.isExpanded('a')).toBe(true)
      expect(model.isExpanded('b')).toBe(false)
      expect(ids(model)).toEqual(['a', 'a1', 'a2', 'b'])
    })

    it('emits one event where setExpansion + refresh emitted two', () => {
      const updates = [['a', true] as const]

      const separate = new TreeModel({ dataSource: eagerSource(sample()) })
      const separateEvents = counting(separate)
      separate.setExpansion(updates)
      separate.refresh()
      expect(separateEvents()).toBe(2)

      const combined = new TreeModel({ dataSource: eagerSource(sample()) })
      const combinedEvents = counting(combined)
      combined.setExpansionAndRefresh(updates)
      expect(combinedEvents()).toBe(1)

      // Same resulting state, half the events.
      expect(ids(combined)).toEqual(ids(separate))
    })

    it('invalidates the visible cache even when no expansion flag moved', () => {
      // refresh() semantics: the caller's data changed even if expansion did not.
      const roots: N[] = [{ id: 'a' }]
      const model = new TreeModel({ dataSource: eagerSource(roots) })
      expect(ids(model)).toEqual(['a'])

      const structures = counting(model)
      roots.push({ id: 'c' })
      model.setExpansionAndRefresh([])

      expect(structures()).toBe(1)
      expect(ids(model)).toEqual(['a', 'c'])
    })

    it('does not fire onDidChangeExpansion (that is expand/collapse only)', () => {
      const roots = sample()
      const model = new TreeModel({ dataSource: eagerSource(roots) })
      let expansionEvents = 0
      model.onDidChangeExpansion(() => expansionEvents++)

      model.setExpansionAndRefresh([['a', true]])
      expect(expansionEvents).toBe(0)

      model.collapse(roots[0]!)
      expect(expansionEvents).toBe(1)
    })
  })
})
