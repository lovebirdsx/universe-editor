/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  The workbench-ui widgets as real Vim surfaces: each registers through
 *  `useVimSurface` and exposes actions the `list.*` / `surface.*` commands call.
 *  These tests drive the actions directly (what the dispatcher does after a
 *  keymap match) and assert the widget's existing focus model reacted — hjkl,
 *  gg/G, counts and Ctrl+d/u per kind.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCallback, useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Tree } from '../tree/Tree.js'
import { TreeModel } from '../tree/TreeModel.js'
import type { ITreeDataSource } from '../tree/ITreeDataSource.js'
import { useFlatListNavigation } from '../list/useFlatListNavigation.js'
import { useOverlayListNavigation } from '../overlay/useOverlayListNavigation.js'
import { useMenuNavigation } from '../contextMenu/useMenuNavigation.js'
import type { RowModel } from '../contextMenu/menuModel.js'
import { Select } from '../atoms/Select.js'
import {
  __resetVimSurfacesForTests,
  getActiveVimSurface,
} from '../keybinding/vim/vimSurfaceRegistry.js'
import { __resetCtrlNavigationForTests } from '../keybinding/ctrlNavigationRegistry.js'

afterEach(() => {
  cleanup()
  __resetVimSurfacesForTests()
  __resetCtrlNavigationForTests()
})

function surfaceActions() {
  const active = getActiveVimSurface(document)
  expect(active).toBeDefined()
  return active!.surface.actions
}

// --- Tree -------------------------------------------------------------------

interface Node {
  id: string
  children: Node[]
}

function makeTreeModel(): TreeModel<Node> {
  const parent: Node = {
    id: 'p',
    children: [
      { id: 'p/0', children: [] },
      { id: 'p/1', children: [] },
    ],
  }
  const roots: Node[] = [
    parent,
    ...Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, children: [] })),
  ]
  const byId = new Map<string, Node>()
  const index = (node: Node): void => {
    byId.set(node.id, node)
    node.children.forEach(index)
  }
  roots.forEach(index)
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
  return new TreeModel<Node>({ dataSource })
}

function TreeHost({
  model,
  onActivate,
  onRowMenu,
  vimSurfaceId,
  onVimFind,
}: {
  readonly model: TreeModel<Node>
  readonly onActivate: (node: Node) => void
  readonly onRowMenu: (id: string) => void
  readonly vimSurfaceId?: string | undefined
  readonly onVimFind?: (() => void) | undefined
}) {
  return (
    <Tree<Node>
      model={model}
      {...(onVimFind !== undefined ? { onVimFind } : {})}
      onActivate={(node) => onActivate(node.element)}
      {...(vimSurfaceId !== undefined ? { vimSurfaceId } : {})}
      renderRow={(ctx) => (
        <div
          data-row-key={ctx.node.id}
          data-selected={ctx.isSelected}
          data-expanded={ctx.node.hasChildren ? ctx.node.expanded : undefined}
          onContextMenu={() => onRowMenu(ctx.node.id)}
        >
          {ctx.node.id}
        </div>
      )}
    />
  )
}

function selectedRows(): string[] {
  return Array.from(document.querySelectorAll('[data-row-key]'))
    .filter((row) => row.getAttribute('data-selected') === 'true')
    .map((row) => row.getAttribute('data-row-key') ?? '')
}

describe('Tree as a Vim list surface', () => {
  it('exposes find only when the host owns a filter box', () => {
    const onFind = vi.fn()
    const { rerender } = render(
      <TreeHost model={makeTreeModel()} onActivate={() => {}} onRowMenu={() => {}} />,
    )
    act(() => screen.getByRole('tree').focus())
    expect(surfaceActions().find).toBeUndefined()
    rerender(
      <TreeHost
        model={makeTreeModel()}
        onActivate={() => {}}
        onRowMenu={() => {}}
        onVimFind={onFind}
      />,
    )
    act(() => surfaceActions().find?.())
    expect(onFind).toHaveBeenCalledTimes(1)
  })

  it('registers with the host id and drives hjkl / gg / G / counts / Ctrl+d', () => {
    const model = makeTreeModel()
    render(
      <TreeHost model={model} onActivate={() => {}} onRowMenu={() => {}} vimSurfaceId="explorer" />,
    )
    act(() => screen.getByRole('tree').focus())
    expect(getActiveVimSurface(document)?.surfaceKey).toBe('list:explorer')

    const actions = surfaceActions()
    act(() => actions.first?.(0))
    expect(selectedRows()).toEqual(['p'])

    // A count resolves to one selection change.
    act(() => actions.move?.('down', 3))
    expect(selectedRows()).toEqual(['r2'])
    act(() => actions.move?.('up', 2))
    expect(selectedRows()).toEqual(['r0'])

    act(() => actions.last?.(0))
    expect(selectedRows()).toEqual(['r19'])
    act(() => actions.first?.(0))
    expect(selectedRows()).toEqual(['p'])

    act(() => actions.page?.('down', 1))
    expect(selectedRows()).toEqual(['r9'])
    act(() => actions.page?.('up', 1))
    expect(selectedRows()).toEqual(['p'])
  })

  it('treats a count on gg / G as the 1-based target row', () => {
    const model = makeTreeModel()
    render(<TreeHost model={model} onActivate={() => {}} onRowMenu={() => {}} />)
    act(() => screen.getByRole('tree').focus())
    const actions = surfaceActions()
    // Visible rows: p, r0, r1, ... (the parent is collapsed).
    act(() => actions.first?.(5))
    expect(selectedRows()).toEqual(['r3'])
    act(() => actions.last?.(3))
    expect(selectedRows()).toEqual(['r1'])
    act(() => actions.last?.(999))
    expect(selectedRows()).toEqual(['r19'])
    act(() => actions.first?.(0))
    expect(selectedRows()).toEqual(['p'])
  })

  it('auto-generates a surface key and expands/collapses/toggles', () => {
    const model = makeTreeModel()
    render(<TreeHost model={model} onActivate={() => {}} onRowMenu={() => {}} />)
    act(() => screen.getByRole('tree').focus())
    expect(getActiveVimSurface(document)?.surfaceKey).toMatch(/^list:auto:/)

    const actions = surfaceActions()
    act(() => actions.first?.(0))
    expect(document.querySelector('[data-row-key="p"]')?.getAttribute('data-expanded')).toBe(
      'false',
    )
    act(() => actions.expand?.(1))
    expect(document.querySelector('[data-row-key="p"]')?.getAttribute('data-expanded')).toBe('true')
    act(() => actions.collapse?.(1))
    expect(document.querySelector('[data-row-key="p"]')?.getAttribute('data-expanded')).toBe(
      'false',
    )
    act(() => actions.toggle?.(1))
    expect(document.querySelector('[data-row-key="p"]')?.getAttribute('data-expanded')).toBe('true')
  })

  it('scrolls the viewport without changing the selection', () => {
    const model = makeTreeModel()
    render(<TreeHost model={model} onActivate={() => {}} onRowMenu={() => {}} />)
    act(() => screen.getByRole('tree').focus())
    const actions = surfaceActions()
    act(() => actions.first?.(0))

    const tree = screen.getByRole('tree')
    tree.scrollTop = 100
    act(() => actions.scrollViewport?.('up', 2))
    expect(tree.scrollTop).toBe(56)
    act(() => actions.scrollViewport?.('down', 3))
    expect(tree.scrollTop).toBe(122)
    expect(selectedRows()).toEqual(['p'])
  })

  it('activates leaves with preview and raises the row context menu', () => {
    const model = makeTreeModel()
    const onActivate = vi.fn()
    const onRowMenu = vi.fn()
    render(<TreeHost model={model} onActivate={onActivate} onRowMenu={onRowMenu} />)
    act(() => screen.getByRole('tree').focus())

    const actions = surfaceActions()
    act(() => actions.first?.(0))
    act(() => actions.move?.('down', 1))
    act(() => actions.activate?.(1, true))
    expect(onActivate).toHaveBeenCalledTimes(1)
    expect(onActivate.mock.calls[0]?.[0]).toMatchObject({ id: 'r0' })

    onRowMenu.mockClear()
    act(() => actions.contextMenu?.(1))
    expect(onRowMenu).toHaveBeenCalledWith('r0')
  })
})

// --- Flat list --------------------------------------------------------------

function FlatListHost({
  itemCount = 20,
  onActivate,
  onMoveHorizontal,
  vimSurfaceId,
}: {
  readonly itemCount?: number
  readonly onActivate?: ((index: number) => void) | undefined
  readonly onMoveHorizontal?: ((direction: 'left' | 'right', index: number) => void) | undefined
  readonly vimSurfaceId?: string | undefined
}) {
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)
  const getItemKey = useCallback((i: number) => `row-${i}`, [])
  const getContainer = useCallback(() => containerRef.current, [])
  const nav = useFlatListNavigation({
    count: itemCount,
    focusedIndex,
    onFocusChange: setFocusedIndex,
    getItemKey,
    getContainer,
    ...(onActivate !== undefined ? { onActivate: (index: number) => onActivate(index) } : {}),
    ...(onMoveHorizontal !== undefined ? { onMoveHorizontal } : {}),
    ...(vimSurfaceId !== undefined ? { vimSurfaceId } : {}),
  })
  return (
    <div ref={containerRef} data-testid="list" {...nav.containerProps}>
      {Array.from({ length: itemCount }, (_, i) => (
        <div key={i} {...nav.getRowProps(i)}>
          row {i}
        </div>
      ))}
    </div>
  )
}

function flatSelection(): string[] {
  return Array.from(document.querySelectorAll('[data-row-key]'))
    .filter((row) => row.getAttribute('aria-selected') === 'true')
    .map((row) => row.getAttribute('data-row-key') ?? '')
}

describe('FlatList as a Vim list surface', () => {
  it('drives hjkl / gg / G / counts / Ctrl+d', () => {
    render(<FlatListHost vimSurfaceId="extensions" />)
    act(() => screen.getByTestId('list').focus())
    expect(getActiveVimSurface(document)?.surfaceKey).toBe('list:extensions')

    const actions = surfaceActions()
    act(() => actions.first?.(0))
    expect(flatSelection()).toEqual(['row-0'])
    act(() => actions.move?.('down', 3))
    expect(flatSelection()).toEqual(['row-3'])
    act(() => actions.move?.('up', 2))
    expect(flatSelection()).toEqual(['row-1'])
    act(() => actions.last?.(0))
    expect(flatSelection()).toEqual(['row-19'])
    act(() => actions.first?.(0))
    act(() => actions.page?.('down', 1))
    expect(flatSelection()).toEqual(['row-10'])
    act(() => actions.page?.('up', 1))
    expect(flatSelection()).toEqual(['row-0'])
  })

  it('treats a count on gg / G as the 1-based target row', () => {
    render(<FlatListHost />)
    act(() => screen.getByTestId('list').focus())
    const actions = surfaceActions()
    act(() => actions.first?.(5))
    expect(flatSelection()).toEqual(['row-4'])
    act(() => actions.last?.(3))
    expect(flatSelection()).toEqual(['row-2'])
    act(() => actions.last?.(999))
    expect(flatSelection()).toEqual(['row-19'])
    act(() => actions.last?.(0))
    expect(flatSelection()).toEqual(['row-19'])
  })

  it('scrolls the viewport without moving the focused row', () => {
    render(<FlatListHost vimSurfaceId="extensions" />)
    act(() => screen.getByTestId('list').focus())
    const actions = surfaceActions()
    act(() => actions.first?.(0))

    const list = screen.getByTestId('list')
    list.scrollTop = 100
    act(() => actions.scrollViewport?.('down', 2))
    expect(list.scrollTop).toBe(144)
    expect(flatSelection()).toEqual(['row-0'])
  })

  it('activates only when the host owns activation', () => {
    const onActivate = vi.fn()
    render(<FlatListHost itemCount={3} onActivate={onActivate} />)
    act(() => screen.getByTestId('list').focus())
    const actions = surfaceActions()
    act(() => actions.move?.('down', 2))
    act(() => actions.activate?.(1, false))
    expect(onActivate).toHaveBeenCalledWith(2)
  })

  it('leaves horizontal movement to a host that implements it', () => {
    const onMoveHorizontal = vi.fn()
    render(<FlatListHost itemCount={3} onActivate={() => {}} />)
    act(() => screen.getByTestId('list').focus())
    const actions = surfaceActions()
    act(() => actions.first?.(0))
    act(() => actions.move?.('right', 1))
    expect(onMoveHorizontal).not.toHaveBeenCalled()

    cleanup()
    __resetVimSurfacesForTests()
    render(<FlatListHost itemCount={3} onMoveHorizontal={onMoveHorizontal} />)
    act(() => screen.getByTestId('list').focus())
    const withHorizontal = getActiveVimSurface(document)
    act(() => withHorizontal!.surface.actions.first?.(0))
    act(() => withHorizontal!.surface.actions.move?.('right', 1))
    expect(onMoveHorizontal).toHaveBeenCalledWith('right', 0)
  })
})

// --- Overlay ----------------------------------------------------------------

function OverlayHost({
  itemCount = 8,
  onActivate,
  onEscape,
}: {
  readonly itemCount?: number
  readonly onActivate: (index: number, opts: { preview: boolean }) => void
  readonly onEscape?: (() => void) | undefined
}) {
  const nav = useOverlayListNavigation({
    count: itemCount,
    initialIndex: 0,
    onActivate,
    ...(onEscape !== undefined ? { onEscape } : {}),
  })
  return (
    <div data-testid="popup-scroll">
      <div data-testid="popup" ref={nav.containerRef} {...nav.containerProps}>
        {Array.from({ length: itemCount }, (_, i) => (
          <div key={i} data-testid={`item-${i}`} {...nav.getItemProps(i)}>
            item {i}
          </div>
        ))}
      </div>
    </div>
  )
}

function activeOverlayIndex(): number {
  return Array.from(document.querySelectorAll('[data-active]')).findIndex(
    (el) => el.getAttribute('data-active') === 'true',
  )
}

describe('Overlay as a Vim overlay surface', () => {
  it('drives hjkl / gg / G / counts / Ctrl+d and activates', () => {
    const onActivate = vi.fn()
    render(<OverlayHost onActivate={onActivate} />)
    expect(getActiveVimSurface(document)?.surface.kind).toBe('overlay')
    expect(getActiveVimSurface(document)?.surfaceKey).toMatch(/^overlay:auto:/)

    const actions = surfaceActions()
    act(() => actions.move?.('down', 2))
    expect(activeOverlayIndex()).toBe(2)
    act(() => actions.activate?.(1, true))
    expect(onActivate).toHaveBeenCalledWith(2, { preview: true })

    act(() => actions.last?.(0))
    expect(activeOverlayIndex()).toBe(7)
    act(() => actions.first?.(0))
    expect(activeOverlayIndex()).toBe(0)
    act(() => actions.page?.('down', 1))
    expect(activeOverlayIndex()).toBe(7)
  })

  it('treats a count on gg / G as the 1-based target row', () => {
    render(<OverlayHost onActivate={() => {}} />)
    const actions = surfaceActions()
    act(() => actions.last?.(5))
    expect(activeOverlayIndex()).toBe(4)
    act(() => actions.first?.(3))
    expect(activeOverlayIndex()).toBe(2)
    act(() => actions.last?.(99))
    expect(activeOverlayIndex()).toBe(7)
  })

  it('scrolls the visible ancestor without moving the active row', () => {
    render(<OverlayHost onActivate={() => {}} />)
    const actions = surfaceActions()
    const scroller = screen.getByTestId('popup-scroll')
    const popup = screen.getByTestId('popup')
    // happy-dom has no layout: give the ancestor a real overflow range so
    // findScrollableElement can tell it apart from the focusable inner div.
    Object.defineProperty(scroller, 'scrollHeight', { value: 400, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
    scroller.scrollTop = 10
    act(() => actions.scrollViewport?.('down', 1))
    expect(scroller.scrollTop).toBe(32)
    expect(popup.scrollTop).toBe(0)
    expect(activeOverlayIndex()).toBe(0)
  })

  it('closes through the Vim escape action', () => {
    const onEscape = vi.fn()
    render(<OverlayHost onActivate={() => {}} onEscape={onEscape} />)
    act(() => surfaceActions().escape?.(1))
    expect(onEscape).toHaveBeenCalledTimes(1)
  })
})

// --- Menu -------------------------------------------------------------------

function MenuHost({
  rows,
  onDismiss,
}: {
  readonly rows: RowModel[]
  readonly onDismiss: () => void
}) {
  useMenuNavigation(rows, true, true, undefined, undefined, onDismiss)
  return <div data-testid="menu-host" />
}

function makeMenuRows() {
  const runA = vi.fn()
  const runB = vi.fn()
  const runE = vi.fn()
  const rows: RowModel[] = [
    { kind: 'item', id: 'a', label: 'A', icon: undefined, run: runA },
    { kind: 'separator', id: 'sep' },
    { kind: 'item', id: 'b', label: 'B', icon: undefined, run: runB },
    {
      kind: 'submenu',
      id: 's',
      label: 'S',
      icon: undefined,
      children: [{ kind: 'item', id: 'c', label: 'C', icon: undefined, run: vi.fn() }],
    },
    { kind: 'item', id: 'd', label: 'D', icon: undefined, disabled: true, run: vi.fn() },
    { kind: 'item', id: 'e', label: 'E', icon: undefined, run: runE },
  ]
  return { rows, runA, runB, runE }
}

describe('Menu as a Vim menu surface', () => {
  it('steps with counts, skips separators/disabled rows and activates', () => {
    const { rows, runA, runB, runE } = makeMenuRows()
    render(<MenuHost rows={rows} onDismiss={() => {}} />)
    expect(getActiveVimSurface(document)?.surface.kind).toBe('menu')
    expect(getActiveVimSurface(document)?.surfaceKey).toMatch(/^menu:auto:/)

    const actions = surfaceActions()
    // Opening highlight is the first navigable row.
    act(() => actions.move?.('down', 1))
    act(() => actions.activate?.(1, false))
    expect(runB).toHaveBeenCalledTimes(1)

    act(() => actions.move?.('down', 2))
    act(() => actions.activate?.(1, false))
    expect(runE).toHaveBeenCalledTimes(1)

    act(() => actions.first?.(0))
    act(() => actions.activate?.(1, false))
    expect(runA).toHaveBeenCalledTimes(1)
  })

  it('counts only navigable rows for 2gg / 3G', () => {
    const { rows, runA, runB, runE } = makeMenuRows()
    render(<MenuHost rows={rows} onDismiss={() => {}} />)
    const actions = surfaceActions()
    // Navigable rows: a, b, s (submenu), e — the separator and disabled d are skipped.
    act(() => actions.first?.(2))
    act(() => actions.activate?.(1, false))
    expect(runB).toHaveBeenCalledTimes(1)
    act(() => actions.last?.(4))
    act(() => actions.activate?.(1, false))
    expect(runE).toHaveBeenCalledTimes(1)
    act(() => actions.last?.(99))
    act(() => actions.activate?.(1, false))
    expect(runE).toHaveBeenCalledTimes(2)
    expect(runA).not.toHaveBeenCalled()
  })

  it('jumps to the ends with gg/G and pages, and escapes the surface', () => {
    const { rows, runE } = makeMenuRows()
    const onDismiss = vi.fn()
    render(<MenuHost rows={rows} onDismiss={onDismiss} />)

    const actions = surfaceActions()
    act(() => actions.last?.(0))
    act(() => actions.activate?.(1, false))
    expect(runE).toHaveBeenCalledTimes(1)

    act(() => actions.page?.('up', 1))
    act(() => actions.escape?.(1))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})

describe('Menu page / count handling on a five-row menu', () => {
  function fiveRows() {
    const runs = ['a', 'b', 'c', 'd', 'e'].map(() => vi.fn())
    const rows: RowModel[] = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({
      kind: 'item' as const,
      id,
      label: id.toUpperCase(),
      icon: undefined,
      run: runs[i]!,
    }))
    return { rows, runs }
  }

  it('Ctrl+D lands on the last row and Ctrl+U on the first', () => {
    const { rows, runs } = fiveRows()
    render(<MenuHost rows={rows} onDismiss={() => {}} />)
    const actions = surfaceActions()
    act(() => actions.page?.('down', 1))
    act(() => actions.activate?.(1, false))
    expect(runs[4]).toHaveBeenCalledTimes(1)
    act(() => actions.page?.('up', 1))
    act(() => actions.activate?.(1, false))
    expect(runs[0]).toHaveBeenCalledTimes(1)
  })

  it('G is the last row while 1G is the first', () => {
    const { rows, runs } = fiveRows()
    render(<MenuHost rows={rows} onDismiss={() => {}} />)
    const actions = surfaceActions()
    act(() => actions.last?.(0))
    act(() => actions.activate?.(1, false))
    expect(runs[4]).toHaveBeenCalledTimes(1)
    act(() => actions.last?.(1))
    act(() => actions.activate?.(1, false))
    expect(runs[0]).toHaveBeenCalledTimes(1)
  })
})

// --- Select -----------------------------------------------------------------

describe('Select as a Vim overlay surface', () => {
  const OPTIONS = [
    { value: 'a', label: 'a' },
    { value: 'b', label: 'b' },
    { value: 'c', label: 'c' },
  ] as const

  it('moves and activates the open popup', () => {
    const onChange = vi.fn()
    render(<Select value="a" options={OPTIONS} onChange={onChange} data-testid="sel" />)
    fireEvent.click(screen.getByTestId('sel'))
    act(() => (screen.getByRole('option', { name: 'a' }) as HTMLElement).focus())

    const active = getActiveVimSurface(document)
    expect(active?.surface.kind).toBe('overlay')
    act(() => active!.surface.actions.move?.('down', 1))
    act(() => active!.surface.actions.activate?.(1, false))
    expect(onChange).toHaveBeenCalledWith('b')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('treats a count on G as the 1-based target option, skipping disabled ones', () => {
    const onChange = vi.fn()
    const options = [
      { value: 'a', label: 'a' },
      { value: 'x', label: 'x', disabled: true },
      { value: 'b', label: 'b' },
      { value: 'c', label: 'c' },
    ] as const
    render(<Select value="a" options={options} onChange={onChange} data-testid="sel" />)
    fireEvent.click(screen.getByTestId('sel'))
    act(() => (screen.getByRole('option', { name: 'a' }) as HTMLElement).focus())
    const actions = getActiveVimSurface(document)!.surface.actions
    // Enabled options are a, b, c; the 2nd is b.
    act(() => actions.last?.(2))
    act(() => actions.activate?.(1, false))
    expect(onChange).toHaveBeenCalledWith('b')
  })

  it('closes on escape', () => {
    render(<Select value="a" options={OPTIONS} onChange={() => {}} data-testid="sel" />)
    fireEvent.click(screen.getByTestId('sel'))
    act(() => (screen.getByRole('option', { name: 'a' }) as HTMLElement).focus())
    act(() => surfaceActions().escape?.(1))
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
