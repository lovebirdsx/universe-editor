/*---------------------------------------------------------------------------------------------
 *  `K` on the shared row surfaces: Tree and useFlatListNavigation resolve the
 *  focused row element and hand its tooltip to the global provider. Driving the
 *  surface actions directly is what the Vim dispatcher does after a keymap match.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { useRef, useState } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { Tree } from '../tree/Tree.js'
import { TreeModel } from '../tree/TreeModel.js'
import type { ITreeDataSource } from '../tree/ITreeDataSource.js'
import { useFlatListNavigation } from '../list/useFlatListNavigation.js'
import { TooltipProvider } from '../tooltip/TooltipProvider.js'
import {
  __resetVimSurfacesForTests,
  getActiveVimSurface,
} from '../keybinding/vim/vimSurfaceRegistry.js'

afterEach(() => {
  cleanup()
  __resetVimSurfacesForTests()
})

function surfaceActions() {
  const active = getActiveVimSurface(document)
  expect(active).toBeDefined()
  return active!.surface.actions
}

interface Node {
  id: string
}

const ROOTS: Node[] = [{ id: 'alpha' }, { id: 'beta' }]

function makeTreeModel(): TreeModel<Node> {
  const dataSource: ITreeDataSource<Node> = {
    getId: (node) => node.id,
    hasChildren: () => false,
    getChildren: () => [],
    getRoots: () => ROOTS,
    getParent: () => null,
  }
  return new TreeModel<Node>({ dataSource })
}

function FlatHost({ focusSelectsFirst }: { focusSelectsFirst?: boolean | undefined }) {
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)
  const nav = useFlatListNavigation({
    count: ROOTS.length,
    focusedIndex,
    onFocusChange: setFocusedIndex,
    getItemKey: (index) => ROOTS[index]!.id,
    getContainer: () => containerRef.current,
    vimSurfaceId: 'flat-hover',
    ...(focusSelectsFirst !== undefined ? { focusSelectsFirst } : {}),
  })
  return (
    <div ref={containerRef} {...nav.containerProps} aria-label="rows">
      {ROOTS.map((node, index) => (
        <div key={node.id} {...nav.getRowProps(index)} data-tooltip={`path/${node.id}`}>
          {node.id}
        </div>
      ))}
    </div>
  )
}

describe('Vim K on shared row surfaces', () => {
  it('shows the focused tree row tooltip', () => {
    render(
      <TooltipProvider delay={0}>
        <Tree<Node>
          model={makeTreeModel()}
          vimSurfaceId="tree-hover"
          renderRow={(ctx) => (
            <div
              data-row-key={ctx.node.id}
              aria-selected={ctx.isSelected}
              data-tooltip={`path/${ctx.node.id}`}
            >
              {ctx.node.id}
            </div>
          )}
        />
      </TooltipProvider>,
    )

    act(() => screen.getByRole('tree').focus())
    const actions = surfaceActions()
    act(() => actions.first?.(0))
    act(() => actions.showHover?.())
    expect(screen.getByRole('tooltip').textContent).toBe('path/alpha')
  })

  it('shows the focused flat-list row tooltip', () => {
    render(
      <TooltipProvider delay={0}>
        <FlatHost />
      </TooltipProvider>,
    )

    act(() => screen.getByRole('listbox').focus())
    const actions = surfaceActions()
    act(() => actions.last?.(0))
    act(() => actions.showHover?.())
    expect(screen.getByRole('tooltip').textContent).toBe('path/beta')
  })

  it('is a no-op when nothing is focused', () => {
    render(
      <TooltipProvider delay={0}>
        <FlatHost focusSelectsFirst={false} />
      </TooltipProvider>,
    )

    act(() => screen.getByRole('listbox').focus())
    act(() => surfaceActions().showHover?.())
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
