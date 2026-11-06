/*---------------------------------------------------------------------------------------------
 *  Tests for workbench/editor/breadcrumbs/SymbolBreadcrumbPicker.tsx
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { observableValue } from '@universe-editor/platform'
import type { monaco } from '../../../editor/monaco/MonacoLoader.js'
import type { IOutlineScope } from '../../../../services/languageFeatures/OutlineService.js'
import { SymbolBreadcrumbPicker } from '../SymbolBreadcrumbPicker.js'
import { createSymbolPickerSnapshot } from '../symbolPickerModel.js'

function symbol(
  name: string,
  line: number,
  children: monaco.languages.DocumentSymbol[] = [],
): monaco.languages.DocumentSymbol {
  const range = { startLineNumber: line, startColumn: 1, endLineNumber: line + 5, endColumn: 1 }
  return {
    name,
    detail: '',
    kind: 12 as monaco.languages.SymbolKind,
    tags: [],
    range,
    selectionRange: range,
    children,
  }
}

const a1 = symbol('a1', 2)
const a = symbol('a', 1, [a1])
const b = symbol('b', 10)

function makeScope() {
  return {
    outline: observableValue('test.outline', undefined),
    activeSymbol: observableValue('test.activeSymbol', undefined),
    sourceKind: observableValue('test.sourceKind', undefined),
    revealSymbol: vi.fn(),
    captureViewState: vi.fn(() => undefined),
    previewSymbol: vi.fn(),
    restoreViewState: vi.fn(),
  } as unknown as IOutlineScope
}

const anchor = { left: 10, top: 20, width: 80, height: 22 }

function renderPicker(active: monaco.languages.DocumentSymbol = a1, onBlur?: () => void) {
  const scope = makeScope()
  const onConfirm = vi.fn()
  const onClose = vi.fn()
  const snapshot = createSymbolPickerSnapshot(
    { uri: 'file:///ws/a.ts', roots: [a, b], languageId: 'typescript', version: 1 },
    active,
    'position',
  )
  render(
    <SymbolBreadcrumbPicker
      anchor={anchor}
      snapshot={snapshot}
      scope={scope}
      onConfirm={onConfirm}
      onClose={onClose}
      {...(onBlur ? { onBlur } : {})}
    />,
  )
  return { scope, onConfirm, onClose, snapshot }
}

describe('SymbolBreadcrumbPicker', () => {
  it('expands the ancestors and selects the active symbol', () => {
    const { snapshot } = renderPicker()
    const rows = screen.getAllByRole('treeitem')
    expect(rows.map((row) => row.textContent)).toEqual(['a', 'a1', 'b'])
    const activeRow = rows.find((row) => row.getAttribute('data-selected') === 'true')
    expect(activeRow?.textContent).toBe('a1')
    expect(snapshot.ancestorIds).toEqual(['0'])
  })

  it('focuses the tree so arrow keys work immediately', () => {
    renderPicker()
    const tree = screen.getByRole('tree')
    expect(document.activeElement).toBe(tree)
  })

  it('reports focus leaving the picker', () => {
    const onBlur = vi.fn()
    renderPicker(a1, onBlur)
    fireEvent.blur(screen.getByRole('tree'))
    expect(onBlur).toHaveBeenCalled()
  })

  it('previews the symbol while the selection moves', () => {
    const { scope } = renderPicker()
    const tree = screen.getByRole('tree')
    vi.mocked(scope.previewSymbol).mockClear()

    fireEvent.keyDown(tree, { key: 'ArrowDown', code: 'ArrowDown' })

    expect(scope.previewSymbol).toHaveBeenCalledWith(b)
    expect(scope.revealSymbol).not.toHaveBeenCalled()
  })

  it('confirms the focused symbol on Enter', () => {
    const { onConfirm } = renderPicker()
    const tree = screen.getByRole('tree')

    fireEvent.keyDown(tree, { key: 'Enter', code: 'Enter' })

    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ symbol: a1 }))
  })

  it('confirms a clicked symbol', () => {
    const { onConfirm } = renderPicker()
    fireEvent.click(screen.getByText('b'))
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ symbol: b }))
  })

  it('collapses a branch from the twistie without confirming', () => {
    const { onConfirm } = renderPicker()
    const twistie = screen.getByRole('button', { name: 'Collapse symbol' })

    // Keep DOM focus on the tree: a focusable twistie loses it to focusout.
    expect(fireEvent.mouseDown(twistie)).toBe(false)
    fireEvent.click(twistie)

    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.queryByText('a1')).toBeNull()
  })

  it('closes on Escape', () => {
    const { onClose } = renderPicker()
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows an empty state without symbols', () => {
    const snapshot = createSymbolPickerSnapshot(undefined, undefined, 'position')
    render(
      <SymbolBreadcrumbPicker
        anchor={anchor}
        snapshot={snapshot}
        scope={makeScope()}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('No symbols found.')).toBeTruthy()
  })
})
