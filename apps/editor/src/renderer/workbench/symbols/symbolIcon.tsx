/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Single source of truth for symbol icons across the Outline view, breadcrumbs
 *  and the Go to Symbol quick picks. Each Monaco 0-based SymbolKind maps to a
 *  VSCode codicon glyph plus a semantic color (callable = purple, data = blue,
 *  type = orange), mirroring VSCode's symbolIcon theming. Agent-session rows are
 *  the exception: their role / tool-call glyphs come from `acpGlyphs`, shared
 *  with the chat timeline so both surfaces read identically.
 *
 *  Markdown headings are SymbolKind.String (14); in markdown files they render as
 *  a `#` (lucide Hash) instead of the codicon, matching the heading convention.
 *--------------------------------------------------------------------------------------------*/

import type { ReactNode } from 'react'
import { Hash } from 'lucide-react'
import {
  ACP_OUTLINE_LANGUAGE_ID,
  decodeAcpOutlineKind,
} from '../../services/acp/session/acpTimelineOutline.js'
import { outlineRowGlyphSpec, renderAcpGlyph } from './acpGlyphs.js'

const CALLABLE = 'var(--vscode-symbolIcon-functionForeground)'
const VARIABLE = 'var(--vscode-symbolIcon-variableForeground)'
const TYPE = 'var(--vscode-symbolIcon-classForeground)'
const DEFAULT = 'var(--vscode-symbolIcon-defaultForeground)'

interface SymbolIconSpec {
  readonly codicon: string
  readonly color: string
}

// Indexed by Monaco's 0-based SymbolKind; codicon names match monaco's codicon library.
const SYMBOL_ICONS: Record<number, SymbolIconSpec> = {
  0: { codicon: 'symbol-file', color: DEFAULT }, // File
  1: { codicon: 'symbol-module', color: DEFAULT }, // Module
  2: { codicon: 'symbol-namespace', color: DEFAULT }, // Namespace
  3: { codicon: 'symbol-package', color: DEFAULT }, // Package
  4: { codicon: 'symbol-class', color: TYPE }, // Class
  5: { codicon: 'symbol-method', color: CALLABLE }, // Method
  6: { codicon: 'symbol-property', color: VARIABLE }, // Property
  7: { codicon: 'symbol-field', color: VARIABLE }, // Field
  8: { codicon: 'symbol-constructor', color: CALLABLE }, // Constructor
  9: { codicon: 'symbol-enum', color: TYPE }, // Enum
  10: { codicon: 'symbol-interface', color: TYPE }, // Interface
  11: { codicon: 'symbol-function', color: CALLABLE }, // Function
  12: { codicon: 'symbol-variable', color: VARIABLE }, // Variable
  13: { codicon: 'symbol-constant', color: VARIABLE }, // Constant
  14: { codicon: 'symbol-string', color: DEFAULT }, // String (markdown headings handled separately)
  15: { codicon: 'symbol-numeric', color: DEFAULT }, // Number
  16: { codicon: 'symbol-boolean', color: DEFAULT }, // Boolean
  17: { codicon: 'symbol-array', color: DEFAULT }, // Array
  18: { codicon: 'symbol-object', color: DEFAULT }, // Object
  19: { codicon: 'symbol-key', color: DEFAULT }, // Key
  20: { codicon: 'symbol-null', color: DEFAULT }, // Null
  21: { codicon: 'symbol-enum-member', color: TYPE }, // EnumMember
  22: { codicon: 'symbol-struct', color: TYPE }, // Struct
  23: { codicon: 'symbol-event', color: CALLABLE }, // Event
  24: { codicon: 'symbol-operator', color: CALLABLE }, // Operator
  25: { codicon: 'symbol-type-parameter', color: TYPE }, // TypeParameter
  // Sentinel kinds beyond Monaco's SymbolKind range, synthesized by non-text
  // outline sources: git/perforce graph rows (see services/gitGraph/graphOutline).
  200: { codicon: 'git-commit', color: DEFAULT }, // Graph commit / changelist
  201: { codicon: 'primitive-dot', color: DEFAULT }, // Graph uncommitted / pending row
}

const FALLBACK: SymbolIconSpec = { codicon: 'symbol-misc', color: DEFAULT }
const STRING_KIND = 14

/** Markdown headings (SymbolKind.String in a markdown file) render as a `#`. */
function isMarkdownHeading(kind: number, languageId: string | undefined): boolean {
  return kind === STRING_KIND && languageId === 'markdown'
}

function HashIcon({ size }: { size: number }): ReactNode {
  return <Hash size={size} color={DEFAULT} />
}

// Agent-session outline rows encode a message role / tool-call kind in their
// SymbolKind (see acpTimelineOutline). Glyphs and tints come from `acpGlyphs`,
// the table the chat timeline draws from too.
function AcpOutlineIcon({ kind, size }: { kind: number; size: number }): ReactNode {
  return renderAcpGlyph(outlineRowGlyphSpec(decodeAcpOutlineKind(kind)), size)
}

function CodiconIcon({ spec, size }: { spec: SymbolIconSpec; size: number }): ReactNode {
  return (
    <span
      className={`codicon codicon-${spec.codicon}`}
      style={{ fontSize: size, color: spec.color, lineHeight: 1 }}
    />
  )
}

/** Symbol icon for the Outline view and breadcrumbs, where the kind is known directly. */
export function SymbolIcon({
  kind,
  languageId,
  size = 16,
}: {
  kind: number
  languageId?: string | undefined
  size?: number
}): ReactNode {
  if (languageId === ACP_OUTLINE_LANGUAGE_ID) return <AcpOutlineIcon kind={kind} size={size} />
  if (isMarkdownHeading(kind, languageId)) return <HashIcon size={size} />
  return <CodiconIcon spec={SYMBOL_ICONS[kind] ?? FALLBACK} size={size} />
}

/** Icon id encoding a markdown heading, so the quick pick can render a `#` for it. */
export const SYMBOL_HEADING_ICON_ID = 'symbol-heading'

/** Build the quick pick icon id for a symbol, special-casing markdown headings. */
export function symbolIconId(kind: number, languageId: string | undefined): string {
  return isMarkdownHeading(kind, languageId) ? SYMBOL_HEADING_ICON_ID : `symbol-kind-${kind}`
}

/**
 * Renders a quick pick icon for a `symbol-kind-<n>` or `symbol-heading` id.
 * Returns undefined for ids this resolver doesn't own (header / agent icons).
 */
export function renderSymbolIconById(iconId: string, size: number): ReactNode | undefined {
  if (iconId === SYMBOL_HEADING_ICON_ID) return <HashIcon size={size} />
  const match = /^symbol-kind-(\d+)$/.exec(iconId)
  if (!match) return undefined
  return <CodiconIcon spec={SYMBOL_ICONS[Number(match[1])] ?? FALLBACK} size={size} />
}
