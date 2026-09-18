/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/editor/Breadcrumbs.tsx
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import {
  InstantiationService,
  observableValue,
  ServiceCollection,
  type IEditorInput,
} from '@universe-editor/platform'
import type { monaco } from '../monaco/MonacoLoader.js'
import { ServicesContext } from '../../useService.js'
import {
  IOutlineService,
  type IOutlineScope,
  type OutlineModel,
  type OutlineSourceKind,
} from '../../../services/languageFeatures/OutlineService.js'
import { EditorGroupContext } from '../EditorGroupContext.js'
import { Breadcrumbs } from '../Breadcrumbs.js'

function makeSymbol(name: string): monaco.languages.DocumentSymbol {
  const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }
  return {
    name,
    detail: '',
    kind: 14 as monaco.languages.SymbolKind,
    tags: [],
    range,
    selectionRange: range,
    children: [],
  }
}

function makeInput(name: string): IEditorInput {
  return { getName: () => name } as unknown as IEditorInput
}

/** A group's outline: one symbol, which is also the caret's symbol. */
function makeScope(symbolName: string) {
  const symbol = makeSymbol(symbolName)
  const scope: IOutlineScope = {
    outline: observableValue<OutlineModel | undefined>('test.outline', {
      uri: `file:///ws/${symbolName}.md`,
      roots: [symbol],
      languageId: 'markdown',
      version: 1,
    }),
    activeSymbol: observableValue<monaco.languages.DocumentSymbol | undefined>(
      'test.activeSymbol',
      symbol,
    ),
    sourceKind: observableValue<OutlineSourceKind | undefined>('test.sourceKind', 'file'),
    revealSymbol: vi.fn(),
    captureViewState: () => undefined,
    previewSymbol: () => {},
    restoreViewState: () => {},
  }
  return { scope, symbol, reveal: scope.revealSymbol as ReturnType<typeof vi.fn> }
}

/** The service stub: `forGroup` hands back the scope of the group asked for. */
function makeOutlineService(scopes: Map<number, IOutlineScope>, active: IOutlineScope) {
  return {
    _serviceBrand: undefined,
    outline: active.outline,
    activeSymbol: active.activeSymbol,
    sourceKind: active.sourceKind,
    revealSymbol: active.revealSymbol,
    captureViewState: active.captureViewState,
    previewSymbol: active.previewSymbol,
    restoreViewState: active.restoreViewState,
    forGroup: (groupId: number | undefined) =>
      (groupId !== undefined ? scopes.get(groupId) : undefined) ?? active,
  }
}

function renderBreadcrumbs(children: ReactNode, active: IOutlineScope) {
  const services = new ServiceCollection()
  services.set(IOutlineService, makeOutlineService(new Map(), active) as never)
  const instantiation = new InstantiationService(services)
  return render(
    <ServicesContext.Provider value={instantiation}>{children}</ServicesContext.Provider>,
  )
}

/** Two groups side by side, each with its own breadcrumbs and its own outline. */
function renderSplitView() {
  const left = makeScope('AlphaSymbol')
  const right = makeScope('BetaSymbol')
  const scopes = new Map([
    [1, left.scope],
    [2, right.scope],
  ])
  const services = new ServiceCollection()
  services.set(IOutlineService, makeOutlineService(scopes, right.scope) as never)
  const instantiation = new InstantiationService(services)

  render(
    <ServicesContext.Provider value={instantiation}>
      <EditorGroupContext.Provider value={{ id: 1 } as never}>
        <Breadcrumbs input={makeInput('a.md')} />
      </EditorGroupContext.Provider>
      <EditorGroupContext.Provider value={{ id: 2 } as never}>
        <Breadcrumbs input={makeInput('b.md')} />
      </EditorGroupContext.Provider>
    </ServicesContext.Provider>,
  )
  return { left, right }
}

describe('Breadcrumbs', () => {
  it("shows each group's own symbol path, not the focused group's", () => {
    const { left } = renderSplitView()
    const crumbs = screen.getAllByTestId('editor-breadcrumbs')
    expect(crumbs.length).toBe(2)
    const leftCrumb = crumbs[0]!
    const rightCrumb = crumbs[1]!

    expect(within(leftCrumb).getByText('a.md')).toBeTruthy()
    expect(within(leftCrumb).getByText('AlphaSymbol')).toBeTruthy()
    expect(within(leftCrumb).queryByText('BetaSymbol')).toBeNull()

    expect(within(rightCrumb).getByText('b.md')).toBeTruthy()
    expect(within(rightCrumb).getByText('BetaSymbol')).toBeTruthy()
    expect(within(rightCrumb).queryByText('AlphaSymbol')).toBeNull()
    expect(left.reveal).not.toHaveBeenCalled()
  })

  it('reveals through the scope of the group whose segment was clicked', () => {
    const { left, right } = renderSplitView()
    const leftCrumb = screen.getAllByTestId('editor-breadcrumbs')[0]!

    fireEvent.click(within(leftCrumb).getByText('AlphaSymbol'))

    expect(left.reveal).toHaveBeenCalledWith(left.symbol)
    expect(right.reveal).not.toHaveBeenCalled()
  })

  it('falls back to the active scope when rendered outside a group', () => {
    const active = makeScope('AlphaSymbol')
    renderBreadcrumbs(<Breadcrumbs input={makeInput('a.md')} />, active.scope)

    const crumb = screen.getByTestId('editor-breadcrumbs')
    expect(within(crumb).getByText('AlphaSymbol')).toBeTruthy()

    fireEvent.click(within(crumb).getByText('AlphaSymbol'))
    expect(active.reveal).toHaveBeenCalledWith(active.symbol)
  })
})
