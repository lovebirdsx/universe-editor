/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  acpGlyphs — the single source of truth for an agent-session row's glyph and
 *  tint, shared by the chat timeline (workbench/agents) and the Outline view's
 *  agent-session rows, so the two surfaces cannot drift apart.
 *
 *  Roles carry a hue (user / agent / thought / sub-agent); every tool kind shares
 *  one neutral grey, keeping colour for "who is speaking" rather than "what
 *  happened". The hues reuse the registered symbolIcon.* tokens — present in both
 *  built-in themes — instead of minting new colour ids.
 *--------------------------------------------------------------------------------------------*/

import type { ReactNode } from 'react'
import {
  Bot,
  Brain,
  CircleHelp,
  FilePen,
  FileText,
  FolderInput,
  Globe,
  Repeat,
  Search,
  Terminal,
  Trash2,
  User,
  Users,
  Wrench,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { AcpMessageRole } from '../../services/acp/session/acpSessionModel.js'
import type { AcpOutlineRow } from '../../services/acp/session/acpTimelineOutline.js'

/** Tint buckets. `thought` and every tool kind deliberately share the neutral grey. */
export type AcpGlyphTone = 'user' | 'agent' | 'thought' | 'subagent' | 'tool'

export const ACP_GLYPH_COLORS: Record<AcpGlyphTone, string> = {
  user: 'var(--vscode-symbolIcon-variableForeground)',
  agent: 'var(--vscode-symbolIcon-functionForeground)',
  thought: 'var(--vscode-symbolIcon-defaultForeground)',
  subagent: 'var(--vscode-symbolIcon-classForeground)',
  tool: 'var(--vscode-symbolIcon-defaultForeground)',
}

export interface AcpGlyphSpec {
  readonly Glyph: LucideIcon
  readonly tone: AcpGlyphTone
}

const MESSAGE_ROLE_GLYPHS: Record<AcpMessageRole, AcpGlyphSpec> = {
  user: { Glyph: User, tone: 'user' },
  agent: { Glyph: Bot, tone: 'agent' },
  thought: { Glyph: Brain, tone: 'thought' },
}

// Indexed by the ACP `ToolKind` values; an unknown kind falls back to the help glyph.
const TOOL_KIND_GLYPHS: Record<string, LucideIcon> = {
  read: FileText,
  edit: FilePen,
  delete: Trash2,
  move: FolderInput,
  search: Search,
  execute: Terminal,
  think: Brain,
  fetch: Globe,
  switch_mode: Repeat,
  other: Wrench,
}

export function messageRoleGlyphSpec(role: AcpMessageRole): AcpGlyphSpec {
  return MESSAGE_ROLE_GLYPHS[role]
}

/** `Users` matches the `Sub Agent` vocabulary of the sub-agent model picker. */
export function subagentGlyphSpec(): AcpGlyphSpec {
  return { Glyph: Users, tone: 'subagent' }
}

export function toolKindGlyphSpec(kind: string): AcpGlyphSpec {
  return { Glyph: TOOL_KIND_GLYPHS[kind] ?? CircleHelp, tone: 'tool' }
}

/**
 * A sub-agent card wins over its wire kind: claude reports Agent/Task as `think`,
 * which would otherwise draw the very glyph a thought row carries.
 */
export function toolCallGlyphSpec(call: {
  readonly kind: string
  readonly subagent?: true
}): AcpGlyphSpec {
  return call.subagent === true ? subagentGlyphSpec() : toolKindGlyphSpec(call.kind)
}

/** The Outline view's projection of the same rows — see acpTimelineOutline. */
export function outlineRowGlyphSpec(row: AcpOutlineRow): AcpGlyphSpec {
  if (row.type === 'subagent') return subagentGlyphSpec()
  return row.type === 'message' ? messageRoleGlyphSpec(row.role) : toolKindGlyphSpec(row.kind)
}

/**
 * Render a spec at a size. Both surfaces go through here, and the tint is passed
 * explicitly rather than left to `currentColor`: the chat surface inherits from
 * `agent.messageRoleForeground`, the Outline from `symbolIcon.defaultForeground`,
 * and those two greys are visibly distinct.
 */
export function renderAcpGlyph(spec: AcpGlyphSpec, size: number): ReactNode {
  const { Glyph } = spec
  return <Glyph size={size} color={ACP_GLYPH_COLORS[spec.tone]} />
}
