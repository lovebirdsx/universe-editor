/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/symbols/acpGlyphs.tsx — the shared
 *  glyph / tint table. What these guard is drift: the chat timeline and the Outline
 *  view must draw the same row with the same stroke, or the table has stopped being
 *  the single source of truth.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Users } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  ACP_OUTLINE_LANGUAGE_ID,
  timelineToOutline,
} from '../../../services/acp/session/acpTimelineOutline.js'
import type { AcpMessageRole, TimelineItem } from '../../../services/acp/session/acpSessionModel.js'
import {
  ACP_GLYPH_COLORS,
  messageRoleGlyphSpec,
  renderAcpGlyph,
  subagentGlyphSpec,
  toolCallGlyphSpec,
  toolKindGlyphSpec,
} from '../acpGlyphs.js'
import { SymbolIcon } from '../symbolIcon.js'

const SIZE = 14

const ROLES = ['user', 'agent', 'thought'] as const

/** The ACP `ToolKind` values, as acpGlyphs indexes them. */
const TOOL_KINDS = [
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
] as const

function strokeOf(node: ReactNode): string | null {
  const { container } = render(<>{node}</>)
  return container.querySelector('svg')?.getAttribute('stroke') ?? null
}

const message = (role: AcpMessageRole): TimelineItem => ({
  kind: 'message',
  id: `m-${role}`,
  message: { id: `m-${role}`, role, text: role, blocks: [], streaming: false },
})

const toolCall = (kind: string, subagent = false): TimelineItem => ({
  kind: 'toolCall',
  id: `t-${kind}`,
  call: {
    id: `t-${kind}`,
    title: kind,
    kind,
    status: 'completed',
    text: '',
    blocks: [],
    diffs: [],
    ...(subagent ? { subagent: true as const } : {}),
  },
})

/** The Outline row for one timeline row, so both surfaces are fed the same input. */
function outlineStroke(item: TimelineItem): string | null {
  const kind = timelineToOutline([item]).roots[0]!.kind
  return strokeOf(<SymbolIcon kind={kind} languageId={ACP_OUTLINE_LANGUAGE_ID} />)
}

describe('acpGlyphs', () => {
  it('draws a chat row and its Outline row with the same stroke', () => {
    for (const role of ROLES) {
      expect(strokeOf(renderAcpGlyph(messageRoleGlyphSpec(role), SIZE))).toBe(
        outlineStroke(message(role)),
      )
    }
    for (const kind of TOOL_KINDS) {
      expect(strokeOf(renderAcpGlyph(toolKindGlyphSpec(kind), SIZE))).toBe(
        outlineStroke(toolCall(kind)),
      )
    }
    expect(strokeOf(renderAcpGlyph(subagentGlyphSpec(), SIZE))).toBe(
      outlineStroke(toolCall('think', true)),
    )
  })

  it('reserves colour for the roles, keeping every tool kind neutral', () => {
    for (const kind of TOOL_KINDS) {
      expect(toolKindGlyphSpec(kind).tone).toBe('tool')
    }
    // A kind we have never seen lands on the same neutral bucket, not a role hue.
    expect(toolKindGlyphSpec('brand-new-kind').tone).toBe('tool')
  })

  it('gives each role its own tone', () => {
    const tones = [
      messageRoleGlyphSpec('user').tone,
      messageRoleGlyphSpec('agent').tone,
      messageRoleGlyphSpec('thought').tone,
      subagentGlyphSpec().tone,
    ]
    expect(new Set(tones).size).toBe(tones.length)
  })

  it('draws a sub-agent card as Users whatever its wire kind', () => {
    // claude reports Agent/Task as `think` — the marker has to beat the kind, or
    // the card would wear the very glyph a thought row carries.
    expect(toolCallGlyphSpec({ kind: 'think', subagent: true }).Glyph).toBe(Users)
    expect(toolCallGlyphSpec({ kind: 'other', subagent: true }).Glyph).toBe(Users)
    expect(toolCallGlyphSpec({ kind: 'think' }).Glyph).not.toBe(Users)
    expect(ACP_GLYPH_COLORS.subagent).not.toBe(ACP_GLYPH_COLORS.thought)
  })
})
