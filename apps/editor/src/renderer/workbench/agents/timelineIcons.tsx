/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  timelineIcons — maps a Timeline Item's kind (message role / tool-call kind /
 *  plan) to a compact lucide icon. The icon replaces the old text badges; the
 *  human-readable kind label is surfaced as a header tooltip by CollapsibleSlot.
 *  Glyphs and tints live in `symbols/acpGlyphs`, shared with the Outline view.
 *--------------------------------------------------------------------------------------------*/

import type { ReactNode } from 'react'
import { CheckCircle2, Circle, ListChecks, Loader2 } from 'lucide-react'
import type {
  AcpMessageRole,
  AcpPlanEntryStatus,
} from '../../services/acp/session/acpSessionService.js'
import { messageRoleGlyphSpec, renderAcpGlyph, toolCallGlyphSpec } from '../symbols/acpGlyphs.js'

const ICON_SIZE = 14

export function roleIcon(role: AcpMessageRole): ReactNode {
  return renderAcpGlyph(messageRoleGlyphSpec(role), ICON_SIZE)
}

/** Tool-call glyph, sub-agent aware — the only entry point tool cards should use. */
export function toolCallIcon(call: { readonly kind: string; readonly subagent?: true }): ReactNode {
  return renderAcpGlyph(toolCallGlyphSpec(call), ICON_SIZE)
}

export function planIcon(): ReactNode {
  return <ListChecks size={ICON_SIZE} />
}

// Per-entry status glyph for the plan checklist. Returns a bare lucide element
// (no styles import) — PlanView adds the spin className for in_progress.
export function planEntryStatusIcon(status: AcpPlanEntryStatus): ReactNode {
  switch (status) {
    case 'completed':
      return <CheckCircle2 size={ICON_SIZE} />
    case 'in_progress':
      return <Loader2 size={ICON_SIZE} />
    case 'pending':
      return <Circle size={ICON_SIZE} />
  }
}
