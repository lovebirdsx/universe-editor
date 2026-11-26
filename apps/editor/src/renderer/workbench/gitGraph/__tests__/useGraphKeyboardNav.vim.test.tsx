/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  The commit graph as a real Vim list surface: the hook registers through
 *  `useVimSurface`, so the `list.*` commands (j/k, gg/G, Ctrl+d/u, Enter, m)
 *  drive the same selection entry point as the arrow keys. These tests call the
 *  actions directly — the dispatcher's job after a keymap match.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCallback, useRef, useState } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import {
  __resetVimSurfacesForTests,
  getActiveVimSurface,
  TooltipProvider,
} from '@universe-editor/workbench-ui'
import { useGraphKeyboardNav } from '../useGraphKeyboardNav.js'

afterEach(() => {
  cleanup()
  __resetVimSurfacesForTests()
})

const ROWS = ['a', 'b', 'c', 'd', 'e']

function Harness({
  onSelect,
  openMenu,
  openCommitChanges,
  vimSurfaceId,
  onShowHover,
}: {
  readonly onSelect: (key: string) => void
  readonly openMenu: (key: string) => void
  readonly openCommitChanges: () => void
  readonly vimSurfaceId?: string | undefined
  readonly onShowHover?: ((row: HTMLElement, key: string) => void) | undefined
}) {
  const [selection, setSelection] = useState<string[]>([])
  const selectionRef = useRef<string[]>([])
  selectionRef.current = selection
  const scrollRef = useRef<HTMLDivElement>(null)
  const select = useCallback(
    (key: string) => {
      selectionRef.current = [key]
      setSelection([key])
      onSelect(key)
    },
    [onSelect],
  )
  const nav = useGraphKeyboardNav({
    rows: ROWS,
    selectionRef,
    select,
    openMenu,
    openCommitChanges,
    scrollRef,
    rowAttribute: 'data-hash',
    rowHeight: 20,
    ...(vimSurfaceId !== undefined ? { vimSurfaceId } : {}),
    ...(onShowHover !== undefined ? { onShowHover } : {}),
  })
  return (
    <div ref={scrollRef} tabIndex={0} data-testid="graph" onKeyDown={nav}>
      {ROWS.map((row) => (
        <div key={row} data-hash={row} aria-selected={selection.includes(row)}>
          <span data-tooltip={`badge-${row}`}>badge</span>
          <span data-tooltip-primary="" data-tooltip={`body-${row}`}>
            {row}
          </span>
        </div>
      ))}
      <output data-testid="selected">{selection.join(',')}</output>
    </div>
  )
}

const selected = () => screen.getByTestId('selected').textContent

function surfaceActions() {
  const active = getActiveVimSurface(document)
  expect(active).toBeDefined()
  return active!.surface.actions
}

describe('useGraphKeyboardNav as a Vim list surface', () => {
  it('registers with the host id and drives hjkl / gg / G / counts / Ctrl+d', () => {
    render(
      <Harness
        onSelect={() => {}}
        openMenu={() => {}}
        openCommitChanges={() => {}}
        vimSurfaceId="git-graph"
      />,
    )
    act(() => screen.getByTestId('graph').focus())
    expect(getActiveVimSurface(document)?.surfaceKey).toBe('list:git-graph')

    const actions = surfaceActions()
    act(() => actions.move?.('down', 2))
    expect(selected()).toBe('b')
    act(() => actions.move?.('down', 2))
    expect(selected()).toBe('d')
    act(() => actions.move?.('up', 1))
    expect(selected()).toBe('c')

    act(() => actions.last?.(0))
    expect(selected()).toBe('e')
    act(() => actions.first?.(0))
    expect(selected()).toBe('a')
    act(() => actions.last?.(0))
    act(() => actions.last?.(1))
    expect(selected()).toBe('a')

    // happy-dom reports a zero-height viewport, so a page is one row.
    act(() => actions.page?.('down', 1))
    expect(selected()).toBe('b')
  })

  it('treats a count on gg / G as the 1-based target row', () => {
    render(<Harness onSelect={() => {}} openMenu={() => {}} openCommitChanges={() => {}} />)
    act(() => screen.getByTestId('graph').focus())
    const actions = surfaceActions()
    act(() => actions.first?.(4))
    expect(selected()).toBe('d')
    act(() => actions.last?.(2))
    expect(selected()).toBe('b')
    act(() => actions.last?.(99))
    expect(selected()).toBe('e')
  })

  it('scrolls the viewport without changing the selection', () => {
    render(<Harness onSelect={() => {}} openMenu={() => {}} openCommitChanges={() => {}} />)
    act(() => screen.getByTestId('graph').focus())
    const actions = surfaceActions()
    act(() => actions.first?.(0))

    const graph = screen.getByTestId('graph')
    graph.scrollTop = 100
    act(() => actions.scrollViewport?.('down', 2))
    expect(graph.scrollTop).toBe(140)
    expect(selected()).toBe('a')
  })

  it('activates the commit-changes view and raises the row menu', () => {
    const onSelect = vi.fn()
    const openMenu = vi.fn()
    const openCommitChanges = vi.fn()
    render(
      <Harness onSelect={onSelect} openMenu={openMenu} openCommitChanges={openCommitChanges} />,
    )
    act(() => screen.getByTestId('graph').focus())

    const actions = surfaceActions()
    act(() => actions.first?.(0))
    act(() => actions.activate?.(1, false))
    expect(openCommitChanges).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenLastCalledWith('a')

    act(() => actions.contextMenu?.(1))
    expect(openMenu).toHaveBeenCalledWith('a')
  })

  it('shows the selected row message tooltip and notifies the host', () => {
    const onShowHover = vi.fn()
    render(
      <TooltipProvider delay={0}>
        <Harness
          onSelect={() => {}}
          openMenu={() => {}}
          openCommitChanges={() => {}}
          onShowHover={onShowHover}
        />
      </TooltipProvider>,
    )
    act(() => screen.getByTestId('graph').focus())
    const actions = surfaceActions()
    act(() => actions.first?.(0))
    act(() => actions.showHover?.())

    expect(onShowHover).toHaveBeenCalledWith(expect.any(HTMLElement), 'a')
    // The message span wins over the badge tooltip earlier in the row.
    expect(screen.getByRole('tooltip').textContent).toBe('body-a')
  })

  it('does nothing for K without a selected row', () => {
    const onShowHover = vi.fn()
    render(
      <TooltipProvider delay={0}>
        <Harness
          onSelect={() => {}}
          openMenu={() => {}}
          openCommitChanges={() => {}}
          onShowHover={onShowHover}
        />
      </TooltipProvider>,
    )
    act(() => screen.getByTestId('graph').focus())

    act(() => surfaceActions().showHover?.())
    expect(onShowHover).not.toHaveBeenCalled()
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
