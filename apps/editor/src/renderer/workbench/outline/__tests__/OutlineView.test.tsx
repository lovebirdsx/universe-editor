/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/outline/OutlineView.tsx
 *
 *  Regression for "Outline shows nothing until you switch views and come back":
 *  the view must react to the outline observable filling in *after* it has
 *  already mounted with an empty (or absent) outline — without needing a remount.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
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

function makeSymbol(name: string): monaco.languages.DocumentSymbol {
  return {
    name,
    detail: '',
    kind: 14 as monaco.languages.SymbolKind,
    tags: [],
    range: { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 1 },
    selectionRange: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
    children: [],
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
  return { outline, instantiation }
}

afterEach(() => cleanup())

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
      outline.set({ uri: 'file:///x.ts', roots: [makeSymbol('Alpha')], version: 1 }, undefined)
    })

    expect(screen.queryByText('No symbols found.')).toBeNull()
    expect(screen.getByText('Alpha')).toBeTruthy()
  })

  it('updates the symbol list when the outline changes to another file', () => {
    const { outline, instantiation } = setup({
      uri: 'file:///a.ts',
      roots: [makeSymbol('Alpha')],
      version: 1,
    })

    render(
      <ServicesContext.Provider value={instantiation}>
        <OutlineView />
      </ServicesContext.Provider>,
    )

    expect(screen.getByText('Alpha')).toBeTruthy()

    act(() => {
      outline.set({ uri: 'file:///b.ts', roots: [makeSymbol('Beta')], version: 2 }, undefined)
    })

    expect(screen.queryByText('Alpha')).toBeNull()
    expect(screen.getByText('Beta')).toBeTruthy()
  })

  it('recovers symbols after the outline empties then refills (file switch)', () => {
    const { outline, instantiation } = setup({
      uri: 'file:///a.ts',
      roots: [makeSymbol('Alpha')],
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
      outline.set({ uri: 'file:///b.ts', roots: [makeSymbol('Beta')], version: 2 }, undefined)
    })
    expect(screen.queryByText('No symbols found.')).toBeNull()
    expect(screen.getByText('Beta')).toBeTruthy()
  })
})
