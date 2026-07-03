/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/symbols/symbolIcon.tsx
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import {
  timelineToOutline,
  ACP_OUTLINE_LANGUAGE_ID,
} from '../../../services/acp/acpTimelineOutline.js'
import type { TimelineItem } from '../../../services/acp/acpSessionModel.js'
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

  it('tints agent-session rows by category for at-a-glance scanning', () => {
    const msg = (id: string, role: 'user' | 'agent' | 'thought'): TimelineItem => ({
      kind: 'message',
      id,
      message: { id, role, text: id, blocks: [], streaming: false },
    })
    const tool = (id: string, kind: string): TimelineItem => ({
      kind: 'toolCall',
      id,
      call: { id, title: id, kind, status: 'completed', text: '', blocks: [], diffs: [] },
    })
    const strokeOf = (kind: number): string | null => {
      const { container } = render(<SymbolIcon kind={kind} languageId={ACP_OUTLINE_LANGUAGE_ID} />)
      return container.querySelector('svg')?.getAttribute('stroke') ?? null
    }
    // Each category's kind, read off a single-item outline (conversation grouping
    // would otherwise nest agent/tool rows under the user turn).
    const kindOf = (item: TimelineItem): number => timelineToOutline([item]).roots[0]!.kind
    // A lucide glyph (svg) tinted via the color prop, never a codicon span.
    expect(strokeOf(kindOf(msg('m1', 'user')))).toBe('var(--color-symbol-variable)') // user
    expect(strokeOf(kindOf(msg('m2', 'agent')))).toBe('var(--color-symbol-callable)') // agent
    expect(strokeOf(kindOf(tool('t1', 'delete')))).toBe('var(--color-error-fg)') // delete
    expect(strokeOf(kindOf(tool('t2', 'execute')))).toBe('var(--color-badge-success)') // execute
  })
})
