/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/symbols/symbolIcon.tsx
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import {
  SYMBOL_HEADING_ICON_ID,
  SymbolIcon,
  renderSymbolIconById,
  symbolIconId,
} from '../symbolIcon.js'

describe('symbolIconId', () => {
  it('encodes a markdown heading (String kind in markdown) as the heading id', () => {
    expect(symbolIconId(14, 'markdown')).toBe(SYMBOL_HEADING_ICON_ID)
  })

  it('encodes a non-markdown String as a plain kind id', () => {
    expect(symbolIconId(14, 'typescript')).toBe('symbol-kind-14')
    expect(symbolIconId(14, undefined)).toBe('symbol-kind-14')
  })

  it('encodes other kinds as plain kind ids regardless of language', () => {
    expect(symbolIconId(5, 'markdown')).toBe('symbol-kind-5')
  })
})

describe('renderSymbolIconById', () => {
  it('renders the heading id as a lucide hash (svg), not a codicon', () => {
    const { container } = render(<>{renderSymbolIconById(SYMBOL_HEADING_ICON_ID, 14)}</>)
    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.querySelector('.codicon')).toBeNull()
  })

  it('renders a known kind as a codicon glyph', () => {
    const { container } = render(<>{renderSymbolIconById('symbol-kind-5', 14)}</>)
    expect(container.querySelector('.codicon-symbol-method')).not.toBeNull()
  })

  it('falls back to a misc codicon for an out-of-range kind', () => {
    const { container } = render(<>{renderSymbolIconById('symbol-kind-999', 14)}</>)
    expect(container.querySelector('.codicon-symbol-misc')).not.toBeNull()
  })

  it('returns undefined for ids outside the symbol namespace', () => {
    expect(renderSymbolIconById('files', 14)).toBeUndefined()
    expect(renderSymbolIconById('symbol-kind-abc', 14)).toBeUndefined()
  })
})

describe('SymbolIcon', () => {
  it('renders a markdown heading as a hash', () => {
    const { container } = render(<SymbolIcon kind={14} languageId="markdown" />)
    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.querySelector('.codicon')).toBeNull()
  })

  it('renders a non-markdown String as a codicon', () => {
    const { container } = render(<SymbolIcon kind={14} languageId="typescript" />)
    expect(container.querySelector('.codicon-symbol-string')).not.toBeNull()
  })
})
