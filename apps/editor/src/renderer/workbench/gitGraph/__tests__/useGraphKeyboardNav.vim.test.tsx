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
import { __resetVimSurfacesForTests, getActiveVimSurface } from '@universe-editor/workbench-ui'
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
}: {
  readonly onSelect: (key: string) => void
  readonly openMenu: (key: string) => void
  readonly openCommitChanges: () => void
  readonly vimSurfaceId?: string | undefined
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
  })
  return (
    <div ref={scrollRef} tabIndex={0} data-testid="graph" onKeyDown={nav}>
      {ROWS.map((row) => (
        <div key={row} data-hash={row}>
          {row}
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

    act(() => actions.last?.(1))
    expect(selected()).toBe('e')
    act(() => actions.first?.(1))
    expect(selected()).toBe('a')

    // happy-dom reports a zero-height viewport, so a page is one row.
    act(() => actions.page?.('down', 1))
    expect(selected()).toBe('b')
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
    act(() => actions.first?.(1))
    act(() => actions.activate?.(1, false))
    expect(openCommitChanges).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenLastCalledWith('a')

    act(() => actions.contextMenu?.(1))
    expect(openMenu).toHaveBeenCalledWith('a')
  })
})
