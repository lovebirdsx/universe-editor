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

  describe('resolveExpandedElement', () => {
    /**
     * A lazy source whose rows can be re-keyed after a load (compact chain
     * tails): `resolveExpandedElement(a)` returns `b`, `b` returns itself.
     */
    function lazySource(options: {
      resolve?: (n: N) => N
      load?: (n: N, set: (children: N[]) => void) => Promise<void>
    }) {
      const loaded = new Map<string, N[]>()
      const loadChildren = vi.fn((n: N) => {
        if (options.load) return options.load(n, (children) => loaded.set(n.id, children))
        loaded.set(n.id, n.children ?? [])
        return Promise.resolve()
      })
      const source: ITreeDataSource<N> = {
        getId: (n) => n.id,
        hasChildren: (n) => n.children !== undefined,
        getChildren: (n) => (loaded.has(n.id) ? loaded.get(n.id)! : null),
        loadChildren,
        getRoots: () => roots,
        ...(options.resolve ? { resolveExpandedElement: options.resolve } : {}),
      }
      const roots: N[] = []
      return { source, roots, loadChildren, loaded }
    }

    function deferred(): { promise: Promise<void>; resolve: () => void } {
      let resolve!: () => void
      const promise = new Promise<void>((r) => (resolve = r))
      return { promise, resolve }
    }

    it('moves expansion, selection, focus and the anchor to the resolved row', async () => {
      const a: N = { id: 'a', children: [{ id: 'b' }] }
      const b: N = { id: 'b', children: [{ id: 'leaf' }] }
      const { source, roots } = lazySource({
        resolve: (n) => (n.id === 'a' ? b : n),
        load: async (n, set) => set(n.id === 'a' ? [b] : [{ id: 'leaf' }]),
      })
      roots.push(a)
      const model = new TreeModel({ dataSource: source })
      model.setSelection(['a'], 'a')
      const structures = vi.fn()
      model.onDidChangeStructure(structures)

      await model.expand(a)

      expect(model.isExpanded('b')).toBe(true)
      expect(model.isExpanded('a')).toBe(false)
      expect(model.selection).toEqual(['b'])
      expect(model.focused).toBe('b')
      expect(model.anchor).toBe('b')
      expect(structures).toHaveBeenCalledTimes(1)
    })

    it('does not overwrite a selection the user made while the pull was in flight', async () => {
      const a: N = { id: 'a' }
      const b: N = { id: 'b' }
      const gate = deferred()
      const { source, roots } = lazySource({
        resolve: (n) => (n.id === 'a' ? b : n),
        load: async (n, set) => {
          await gate.promise
          set([{ id: 'child' }])
        },
      })
      roots.push(a, { id: 'c' })
      const model = new TreeModel({ dataSource: source })
      model.setSelection(['a'], 'a')
      const expanding = model.expand(a)
      await Promise.resolve()
      model.setSelection(['c'], 'c')
      gate.resolve()
      await expanding

      // Expansion still lands on the resolved row; only user intent is kept.
      expect(model.isExpanded('b')).toBe(true)
      expect(model.selection).toEqual(['c'])
      expect(model.focused).toBe('c')
      expect(model.anchor).toBe('c')
    })

    it('lets a collapse during the pull win (no re-expand, no migration)', async () => {
      const a: N = { id: 'a' }
      const gate = deferred()
      let resolveCalls = 0
      const { source, roots } = lazySource({
        resolve: () => {
          resolveCalls++
          return { id: 'b' }
        },
        load: async (_n, set) => {
          await gate.promise
          set([{ id: 'child' }])
        },
      })
      roots.push(a)
      const model = new TreeModel({ dataSource: source })
      model.setSelection(['a'], 'a')
      const expanding = model.expand(a)
      await Promise.resolve()
      model.collapse(a)
      gate.resolve()
      await expanding

      expect(model.isExpanded('a')).toBe(false)
      expect(model.isExpanded('b')).toBe(false)
      expect(model.selection).toEqual(['a'])
      expect(resolveCalls).toBe(0)
    })

    it('abandons the migration when the model is reset during the pull', async () => {
      const a: N = { id: 'a' }
      const gate = deferred()
      const { source, roots } = lazySource({
        resolve: () => ({ id: 'b' }),
        load: async (_n, set) => {
          await gate.promise
          set([{ id: 'child' }])
        },
      })
      roots.push(a)
      const model = new TreeModel({ dataSource: source })
      model.setSelection(['a'], 'a')
      const expanding = model.expand(a)
      await Promise.resolve()
      model.reset()
      gate.resolve()
      await expanding

      expect(model.isExpanded('a')).toBe(false)
      expect(model.isExpanded('b')).toBe(false)
      expect(model.selection).toEqual([])
      expect(model.focused).toBeNull()
    })

    it('shares one pull across repeated expands and migrates once', async () => {
      const a: N = { id: 'a' }
      const b: N = { id: 'b', children: [{ id: 'leaf' }] }
      const gate = deferred()
      const { source, roots, loadChildren } = lazySource({
        resolve: (n) => (n.id === 'a' ? b : n),
        load: async (n, set) => {
          await gate.promise
          set(n.id === 'a' ? [b] : (b.children ?? []))
        },
      })
      roots.push(a)
      const model = new TreeModel({ dataSource: source })
      const first = model.expand(a)
      const second = model.expand(a)
      await Promise.resolve()
      expect(loadChildren).toHaveBeenCalledTimes(1)
      gate.resolve()
      await Promise.all([first, second])

      expect(model.isExpanded('b')).toBe(true)
      expect(model.isExpanded('a')).toBe(false)
      // The pull landed once and the chain-tail state was not duplicated.
      expect(model.getExpandedIds()).toEqual(['b'])
    })

    it('pulls an expanded row that becomes visible with no cached children, once on failure', async () => {
      const p: N = { id: 'p', children: [{ id: 'c', children: [{ id: 'leaf' }] }] }
      const loaded = new Map<string, N[]>()
      const loadChildren = vi.fn(async (n: N) => {
        if (n.id === 'c' && !loaded.has('c')) throw new Error('fetch exploded')
        loaded.set(n.id, n.children ?? [])
      })
      const source: ITreeDataSource<N> = {
        getId: (n) => n.id,
        hasChildren: (n) => n.children !== undefined,
        getChildren: (n) => (loaded.has(n.id) ? loaded.get(n.id)! : null),
        loadChildren,
        getRoots: () => [p],
      }
      const model = new TreeModel({ dataSource: source })
      // A restored fold: p and c are expanded, but nothing has been pulled yet.
      model.setExpansion([
        ['p', true],
        ['c', true],
      ])

      expect(model.getVisibleNodes().map((n) => n.id)).toEqual(['p'])
      await vi.waitFor(() => expect(model.getVisibleNodes().map((n) => n.id)).toEqual(['p', 'c']))
      await vi.waitFor(() => expect(model.getVisibleNodes()[1]!.error).toBe('fetch exploded'))
      model.getVisibleNodes()
      model.getVisibleNodes()
      expect(loadChildren).toHaveBeenCalledTimes(2) // p once, c once

      // The explicit gesture retries the failed visible row.
      await model.expand(p.children![0]!)
      expect(loadChildren).toHaveBeenCalledTimes(3)
    })

    it('arms the failure guard from the resolved tail, not the loaded head', async () => {
      const p: N = { id: 'p' }
      const a: N = { id: 'a' }
      const b: N = { id: 'b' }
      const loaded = new Map<string, N[]>([['p', [a]]])
      const loadChildren = vi.fn(async (n: N) => {
        if (n.id === 'a') {
          // The head loads fine and the row identity moves to the tail, whose
          // own pull then fails.
          loaded.set('a', [b])
          loaded.set('p', [b])
          return
        }
        throw new Error('tail exploded')
      })
      const source: ITreeDataSource<N> = {
        getId: (n) => n.id,
        hasChildren: () => true,
        getChildren: (n) => (loaded.has(n.id) ? loaded.get(n.id)! : null),
        loadChildren,
        getRoots: () => [p],
        resolveExpandedElement: (n) => (n.id === 'a' ? b : n),
      }
      const model = new TreeModel({ dataSource: source })
      model.setExpansion([['p', true]])
      expect(ids(model)).toEqual(['p', 'a'])
      model.setSelection(['a'], 'a')

      await model.expand(a)

      expect(ids(model)).toEqual(['p', 'b'])
      expect(model.getVisibleNodes().find((n) => n.id === 'b')?.error).toBe('tail exploded')
      const calls = loadChildren.mock.calls.length
      model.getVisibleNodes()
      model.getVisibleNodes()
      // The tail is visible + expanded with no children, but its failed pull
      // already consumed the one-shot auto-load guard: no per-render retry.
      expect(loadChildren).toHaveBeenCalledTimes(calls)
    })
  })

  describe('on-demand pull lifecycle', () => {
    function deferred(): { promise: Promise<void>; resolve: () => void } {
      let resolve!: () => void
      const promise = new Promise<void>((r) => (resolve = r))
      return { promise, resolve }
    }

    it('re-arms the one-shot pull after a successful load is invalidated', async () => {
      const p: N = { id: 'p', children: [{ id: 'c' }] }
      let loaded = false
      const loadChildren = vi.fn(async () => {
        loaded = true
      })
      const source: ITreeDataSource<N> = {
        getId: (n) => n.id,
        hasChildren: (n) => n.children !== undefined,
        getChildren: (n) => (loaded ? (n.children ?? []) : null),
        loadChildren,
        getRoots: () => [p],
      }
      const model = new TreeModel({ dataSource: source })
      model.setExpansion([['p', true]])

      await vi.waitFor(() => expect(ids(model)).toEqual(['p', 'c']))
      expect(loadChildren).toHaveBeenCalledTimes(1)

      // The source drops its cache while the row stays visible.
      loaded = false
      model.refresh()
      await vi.waitFor(() => expect(ids(model)).toEqual(['p', 'c']))

      expect(loadChildren).toHaveBeenCalledTimes(2)
    })

    it('still retries an explicit expand after loadChildren threw synchronously', async () => {
      const a: N = { id: 'a', children: [{ id: 'c' }] }
      const loadChildren = vi.fn((): Promise<void> => {
        throw new Error('sync boom')
      })
      const source: ITreeDataSource<N> = {
        getId: (n) => n.id,
        hasChildren: (n) => n.children !== undefined,
        getChildren: () => null,
        loadChildren,
        getRoots: () => [a],
      }
      const model = new TreeModel({ dataSource: source })

      await model.expand(a)
      expect(model.getVisibleNodes()[0]!.error).toBe('sync boom')

      await model.expand(a)
      expect(loadChildren).toHaveBeenCalledTimes(2)
    })

    it('lets a collapse during the resolved row pull win', async () => {
      const a: N = { id: 'a', children: [{ id: 'b' }] }
      const b: N = { id: 'b', children: [{ id: 'leaf' }] }
      const gate = deferred()
      const loaded = new Map<string, N[]>([['a', [b]]])
      const source: ITreeDataSource<N> = {
        getId: (n) => n.id,
        hasChildren: (n) => n.children !== undefined,
        getChildren: (n) => (loaded.has(n.id) ? loaded.get(n.id)! : null),
        loadChildren: async (n) => {
          await gate.promise
          loaded.set(n.id, n.children ?? [])
        },
        resolveExpandedElement: (n) => (n.id === 'a' ? b : n),
        getRoots: () => [a],
      }
      const model = new TreeModel({ dataSource: source })
      model.setSelection(['a'], 'a')

      const expanding = model.expand(a)
      await Promise.resolve()
      model.collapse(a)
      gate.resolve()
      await expanding

      expect(model.isExpanded('a')).toBe(false)
      expect(model.isExpanded('b')).toBe(false)
      expect(model.selection).toEqual(['a'])
      expect(model.focused).toBe('a')
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

  it('setSelection with { reveal: false } seeds focus without firing onReveal', () => {
    const model = new TreeModel({ dataSource: eagerSource([{ id: 'a' }, { id: 'b' }]) })
    const onReveal = vi.fn()
    model.onReveal(onReveal)
    // Programmatic seeding (e.g. giving a freshly focused tree a keyboard
    // cursor) must not scroll the viewport to that row.
    model.setSelection(['a'], 'a', { reveal: false })
    expect(model.focused).toBe('a')
    expect(model.isSelected('a')).toBe(true)
    expect(onReveal).not.toHaveBeenCalled()
    // Default stays reveal-on.
    model.setSelection(['b'], 'b')
    expect(onReveal).toHaveBeenCalledWith({ id: 'b' })
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

  describe('range extension anchor', () => {
    const flat = (): TreeModel<N> =>
      new TreeModel({
        dataSource: eagerSource([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]),
      })

    it('keeps the first anchor across repeated Shift+ArrowDown', () => {
      const model = flat()
      model.setSelection(['a'], 'a')
      model.navigate('down', true)
      model.navigate('down', true)
      expect(model.selection).toEqual(['a', 'b', 'c'])
      expect(model.focused).toBe('c')
    })

    it('retracts toward the anchor on Shift+ArrowUp', () => {
      const model = flat()
      model.setSelection(['a'], 'a')
      model.navigate('down', true)
      model.navigate('down', true)
      model.navigate('up', true)
      expect(model.selection).toEqual(['a', 'b'])
      model.navigate('up', true)
      expect(model.selection).toEqual(['a'])
      expect(model.focused).toBe('a')
    })

    it('plain navigation re-anchors at the new focus', () => {
      const model = flat()
      model.setSelection(['a'], 'a')
      model.navigate('down', true) // anchor a, focus b
      model.navigate('down') // plain move to c
      model.navigate('down', true)
      expect(model.selection).toEqual(['c', 'd'])
    })

    it('toggleInSelection moves the anchor to the clicked row', () => {
      const model = flat()
      model.setSelection(['a'], 'a')
      model.toggleInSelection('c')
      model.navigate('down', true)
      expect(model.selection).toEqual(['c', 'd'])
    })

    it('setFocus re-anchors even when the focus does not move', () => {
      const model = flat()
      model.selectRange('a', 'b')
      model.setFocus('b')
      model.navigate('down', true)
      expect(model.selection).toEqual(['b', 'c'])
    })

    it('setSelection re-anchors even when selection and focus are unchanged', () => {
      const model = flat()
      model.selectRange('a', 'b')
      model.setSelection(['a', 'b'], 'b')
      model.navigate('down', true)
      expect(model.selection).toEqual(['b', 'c'])
    })

    it('explicit selectRange accumulates from the anchor it is given', () => {
      const model = flat()
      model.selectRange('a', 'b')
      model.selectRange('a', 'c')
      expect(model.selection).toEqual(['a', 'b', 'c'])
    })

    it('falls back to the focus when a collapse hides the anchor', async () => {
      const parent: N = { id: 'p', children: [{ id: 'a1' }, { id: 'a2' }] }
      const model = new TreeModel({ dataSource: eagerSource([parent, { id: 'b' }, { id: 'c' }]) })
      await model.expand(parent)
      model.selectRange('a1', 'b')
      model.collapse(parent)
      model.extendSelectionTo('c')
      expect(model.selection).toEqual(['b', 'c'])
      // The effective anchor is persisted: re-expanding must not revive a1.
      await model.expand(parent)
      model.extendSelectionTo('b')
      expect(model.selection).toEqual(['b'])
    })

    it('falls back to a single row when both ends are hidden', async () => {
      const parent: N = { id: 'p', children: [{ id: 'a1' }, { id: 'a2' }] }
      const model = new TreeModel({ dataSource: eagerSource([parent, { id: 'b' }]) })
      await model.expand(parent)
      model.selectRange('a1', 'a2')
      model.collapse(parent)
      model.extendSelectionTo('b')
      expect(model.selection).toEqual(['b'])
    })

    it('drops the anchor when invalidateNodes removes it (no revival on re-create)', () => {
      const roots: N[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
      const model = new TreeModel({ dataSource: eagerSource(roots) })
      model.setSelection(['a'], 'a')
      model.navigate('down', true) // anchor a, focus b
      roots.shift()
      model.invalidateNodes(['a'])
      // Re-create the row (undo) so a stale anchor would become visible again.
      roots.unshift({ id: 'a' })
      model.refresh()
      model.extendSelectionTo('c')
      expect(model.selection).toEqual(['b', 'c'])
    })

    it('drops a deleted anchor during refreshWithFocusRecovery (no revival)', () => {
      const roots: N[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
      const model = new TreeModel({ dataSource: eagerSource(roots) })
      model.selectRange('a', 'b')
      model.getVisibleNodes()
      roots.shift()
      model.refreshWithFocusRecovery()
      roots.unshift({ id: 'a' })
      model.refresh()
      model.extendSelectionTo('c')
      expect(model.selection).toEqual(['b', 'c'])
    })

    it('keeps the anchor across a refresh with no removals', () => {
      const model = flat()
      model.setSelection(['a'], 'a')
      model.navigate('down', true) // anchor a, focus b
      model.refreshWithFocusRecovery()
      model.navigate('down', true)
      expect(model.selection).toEqual(['a', 'b', 'c'])
    })

    it('reset clears the anchor', () => {
      const model = flat()
      model.selectRange('b', 'c')
      model.reset()
      model.extendSelectionTo('d')
      expect(model.selection).toEqual(['d'])
    })

    it('collapseSelectionToFocus keeps only the focused row and re-anchors', () => {
      const model = flat()
      model.setSelection(['a'], 'a')
      model.navigate('down', true)
      model.navigate('down', true) // [a, b, c], focus c
      model.collapseSelectionToFocus()
      expect(model.selection).toEqual(['c'])
      expect(model.focused).toBe('c')
      model.extendSelectionTo('d')
      expect(model.selection).toEqual(['c', 'd'])
    })

    it('collapseSelectionToFocus falls back to the first row without a focus', () => {
      const model = flat()
      model.setSelection(['a', 'b'], null)
      model.collapseSelectionToFocus()
      expect(model.selection).toEqual(['a'])
      expect(model.focused).toBe('a')
    })

    it('collapseSelectionToFocus is a no-op for a single row', () => {
      const model = flat()
      model.setSelection(['b'], 'b')
      model.collapseSelectionToFocus()
      expect(model.selection).toEqual(['b'])
      expect(model.focused).toBe('b')
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

  describe('getExpandedIds', () => {
    // Explorer-style: default fully collapsed, only expand on demand.
    const foldingModel = () => {
      const roots: N[] = [
        { id: 'a', children: [{ id: 'a1', children: [{ id: 'a1x' }] }] },
        { id: 'b', children: [{ id: 'b1' }] },
      ]
      return { roots, model: new TreeModel({ dataSource: eagerSource(roots) }) }
    }

    it('starts empty and excludes nodes never touched', () => {
      const { model } = foldingModel()
      model.getVisibleNodes()
      expect(model.getExpandedIds()).toEqual([])
    })

    it('lists user-expanded nodes and drops them again on collapse', async () => {
      const { model, roots } = foldingModel()
      await model.expand(roots[0]!)
      await model.expand(roots[0]!.children![0]!)
      expect([...model.getExpandedIds()].sort()).toEqual(['a', 'a1'])
      model.collapse(roots[0]!)
      expect(model.getExpandedIds()).toEqual(['a1'])
    })

    it('round-trips through setExpansion on a fresh model', async () => {
      const { model: first, roots } = foldingModel()
      await first.expand(roots[0]!)
      await first.expand(roots[1]!)
      const persisted = first.getExpandedIds()
      expect([...persisted].sort()).toEqual(['a', 'b'])

      const { model: second } = foldingModel()
      second.setExpansion(persisted.map((id) => [id, true] as const))
      expect(second.isExpanded('a')).toBe(true)
      expect(second.isExpanded('b')).toBe(true)
      expect(ids(second)).toEqual(['a', 'a1', 'b', 'b1']) // expanded — children visible
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
