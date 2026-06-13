/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/outline/OutlineView.tsx
 *
 *  Regression for "Outline shows nothing until you switch views and come back":
 *  the view must react to the outline observable filling in *after* it has
 *  already mounted with an empty (or absent) outline — without needing a remount.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  InstantiationService,
  ServiceCollection,
  observableValue,
  type IObservable,
} from '@universe-editor/platform'
import type { monaco } from '../../editor/monaco/MonacoLoader.js'
import {
  IOutlineService,
  type OutlineModel,
} from '../../../services/languageFeatures/OutlineService.js'
import { ServicesContext } from '../../useService.js'
import { OutlineView } from '../OutlineView.js'
import { outlineViewState } from '../outlineViewState.js'

function makeSymbol(
  name: string,
  opts: {
    line?: number
    kind?: number
    children?: monaco.languages.DocumentSymbol[]
  } = {},
): monaco.languages.DocumentSymbol {
  const line = opts.line ?? 1
  return {
    name,
    detail: '',
    kind: (opts.kind ?? 14) as monaco.languages.SymbolKind,
    tags: [],
    range: { startLineNumber: line, startColumn: 1, endLineNumber: line + 1, endColumn: 1 },
    selectionRange: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
    children: opts.children ?? [],
  }
}

function setup(initial: OutlineModel | undefined) {
  const outline = observableValue<OutlineModel | undefined>('test.outline', initial)
  const activeSymbol = observableValue<monaco.languages.DocumentSymbol | undefined>(
    'test.activeSymbol',
    undefined,
  )
  const outlineService = {
    _serviceBrand: undefined,
    outline: outline as IObservable<OutlineModel | undefined>,
    activeSymbol,
    revealSymbol: () => {},
    captureViewState: () => undefined,
    previewSymbol: () => {},
    restoreViewState: () => {},
  }
  const services = new ServiceCollection()
  services.set(IOutlineService, outlineService as never)
  const instantiation = new InstantiationService(services)
  return { outline, activeSymbol, instantiation }
}

afterEach(() => cleanup())

beforeEach(() => {
  // outlineViewState is a module-level singleton — reset to defaults so cases
  // that flip preferences don't leak into one another.
  outlineViewState.setFollowCursor(true)
  outlineViewState.setFilterOnType(true)
  outlineViewState.setSortBy('position')
})

function renderView(instantiation: InstantiationService): void {
  render(
    <ServicesContext.Provider value={instantiation}>
      <OutlineView />
    </ServicesContext.Provider>,
  )
}

function rowLabels(): string[] {
  return Array.from(document.querySelectorAll('[role="treeitem"] > span:last-child')).map(
    (el) => el.textContent ?? '',
  )
}

describe('OutlineView', () => {
  it('renders symbols that arrive after mount with an initially empty outline', () => {
    const { outline, instantiation } = setup(undefined)

    render(
      <ServicesContext.Provider value={instantiation}>
        <OutlineView />
      </ServicesContext.Provider>,
    )

    // Mounts empty: shows the placeholder.
    expect(screen.getByText('No symbols found.')).toBeTruthy()

    // The language server finishes analysing and the outline fills in — without
    // any remount the view must now show the symbols.
    act(() => {
      outline.set(
        { uri: 'file:///x.ts', roots: [makeSymbol('Alpha')], languageId: 'typescript', version: 1 },
        undefined,
      )
    })

    expect(screen.queryByText('No symbols found.')).toBeNull()
    expect(screen.getByText('Alpha')).toBeTruthy()
  })

  it('updates the symbol list when the outline changes to another file', () => {
    const { outline, instantiation } = setup({
      uri: 'file:///a.ts',
      roots: [makeSymbol('Alpha')],
      languageId: 'typescript',
      version: 1,
    })

    render(
      <ServicesContext.Provider value={instantiation}>
        <OutlineView />
      </ServicesContext.Provider>,
    )

    expect(screen.getByText('Alpha')).toBeTruthy()

    act(() => {
      outline.set(
        { uri: 'file:///b.ts', roots: [makeSymbol('Beta')], languageId: 'typescript', version: 2 },
        undefined,
      )
    })

    expect(screen.queryByText('Alpha')).toBeNull()
    expect(screen.getByText('Beta')).toBeTruthy()
  })

  it('recovers symbols after the outline empties then refills (file switch)', () => {
    const { outline, instantiation } = setup({
      uri: 'file:///a.ts',
      roots: [makeSymbol('Alpha')],
      languageId: 'typescript',
      version: 1,
    })

    render(
      <ServicesContext.Provider value={instantiation}>
        <OutlineView />
      </ServicesContext.Provider>,
    )
    expect(screen.getByText('Alpha')).toBeTruthy()

    // Switch file: the new editor isn't ready yet, so the outline empties.
    act(() => outline.set(undefined, undefined))
    expect(screen.getByText('No symbols found.')).toBeTruthy()

    // The new file's symbols arrive — must show WITHOUT a remount.
    act(() => {
      outline.set(
        { uri: 'file:///b.ts', roots: [makeSymbol('Beta')], languageId: 'typescript', version: 2 },
        undefined,
      )
    })
    expect(screen.queryByText('No symbols found.')).toBeNull()
    expect(screen.getByText('Beta')).toBeTruthy()
  })

  it('sorts roots by name / position / kind', () => {
    const { instantiation } = setup({
      uri: 'file:///a.ts',
      roots: [
        makeSymbol('Charlie', { line: 1, kind: 11 }),
        makeSymbol('Alpha', { line: 2, kind: 5 }),
        makeSymbol('Bravo', { line: 3, kind: 5 }),
      ],
      languageId: 'typescript',
      version: 1,
    })
    renderView(instantiation)

    // position: document order
    expect(rowLabels()).toEqual(['Charlie', 'Alpha', 'Bravo'])

    act(() => outlineViewState.setSortBy('name'))
    expect(rowLabels()).toEqual(['Alpha', 'Bravo', 'Charlie'])

    // kind: lower kind first (5 before 11), name as tiebreak
    act(() => outlineViewState.setSortBy('kind'))
    expect(rowLabels()).toEqual(['Alpha', 'Bravo', 'Charlie'])
  })

  it('collapses and expands all on toolbar signals, syncing allCollapsed', () => {
    const { instantiation } = setup({
      uri: 'file:///a.ts',
      roots: [makeSymbol('Parent', { children: [makeSymbol('Child', { line: 2 })] })],
      languageId: 'typescript',
      version: 1,
    })
    renderView(instantiation)

    // Default-expanded: child visible, not all collapsed.
    expect(screen.getByText('Child')).toBeTruthy()
    expect(outlineViewState.allCollapsed.get()).toBe(false)

    act(() => outlineViewState.requestCollapseAll())
    expect(screen.queryByText('Child')).toBeNull()
    expect(outlineViewState.allCollapsed.get()).toBe(true)

    act(() => outlineViewState.requestExpandAll())
    expect(screen.getByText('Child')).toBeTruthy()
    expect(outlineViewState.allCollapsed.get()).toBe(false)
  })

  it('follow cursor expands ancestors of and selects the active symbol', () => {
    const child = makeSymbol('Child', { line: 2 })
    const { activeSymbol, instantiation } = setup({
      uri: 'file:///a.ts',
      roots: [makeSymbol('Parent', { children: [child] })],
      languageId: 'typescript',
      version: 1,
    })
    renderView(instantiation)

    act(() => outlineViewState.requestCollapseAll())
    expect(screen.queryByText('Child')).toBeNull()

    // Cursor moves into the child — follow-cursor must reveal it.
    act(() => activeSymbol.set(child, undefined))
    expect(screen.getByText('Child')).toBeTruthy()
  })

  it('filter on type prunes the tree to matches and ancestors', () => {
    const { instantiation } = setup({
      uri: 'file:///a.ts',
      roots: [
        makeSymbol('Alpha', { line: 1 }),
        makeSymbol('Beta', { line: 2, children: [makeSymbol('Gamma', { line: 3 })] }),
      ],
      languageId: 'typescript',
      version: 1,
    })
    renderView(instantiation)
    expect(rowLabels()).toEqual(['Alpha', 'Beta', 'Gamma'])

    // Type to filter — only Gamma (and its ancestor Beta) survive.
    const view = document.querySelector('[role="tree"]') as HTMLElement
    act(() => {
      view.focus()
      fireEvent.keyDown(view, { key: 'g' })
    })
    expect(rowLabels()).toEqual(['Beta', 'Gamma'])
    expect(screen.queryByText('Alpha')).toBeNull()
  })
})
