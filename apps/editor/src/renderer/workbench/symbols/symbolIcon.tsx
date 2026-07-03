/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Single source of truth for symbol icons across the Outline view, breadcrumbs
 *  and the Go to Symbol quick picks. Each Monaco 0-based SymbolKind maps to a
 *  VSCode codicon glyph plus a semantic color (callable = purple, data = blue,
 *  type = orange), mirroring VSCode's symbolIcon theming.
 *
 *  Markdown headings are SymbolKind.String (14); in markdown files they render as
 *  a `#` (lucide Hash) instead of the codicon, matching the heading convention.
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
  Hash,
  Repeat,
  Search,
  Terminal,
  Trash2,
  User,
  Wrench,
} from 'lucide-react'
import {
  ACP_OUTLINE_LANGUAGE_ID,
  decodeAcpOutlineKind,
} from '../../services/acp/acpTimelineOutline.js'

const CALLABLE = 'var(--color-symbol-callable)'
const VARIABLE = 'var(--color-symbol-variable)'
const TYPE = 'var(--color-symbol-type)'
const DEFAULT = 'var(--color-symbol-default)'
// Extra hues for agent-session rows, reusing existing dual-theme tokens so the
// timeline glyphs stay legible in light and dark: destructive = red, run = green.
const DANGER = 'var(--color-error-fg)'
const SUCCESS = 'var(--color-badge-success)'

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
// SymbolKind (see acpTimelineOutline). Render the matching timeline glyph, tinted
// by category so the outline is scannable at a glance.
function AcpOutlineIcon({ kind, size }: { kind: number; size: number }): ReactNode {
  const decoded = decodeAcpOutlineKind(kind)
  if (decoded.type === 'message') {
    switch (decoded.role) {
      case 'user':
        return <User size={size} color={VARIABLE} />
      case 'agent':
        return <Bot size={size} color={CALLABLE} />
      case 'thought':
        return <Brain size={size} color={DEFAULT} />
    }
  }
  switch (decoded.kind) {
    case 'read':
      return <FileText size={size} color={VARIABLE} />
    case 'edit':
      return <FilePen size={size} color={TYPE} />
    case 'delete':
      return <Trash2 size={size} color={DANGER} />
    case 'move':
      return <FolderInput size={size} color={TYPE} />
    case 'search':
      return <Search size={size} color={CALLABLE} />
    case 'execute':
      return <Terminal size={size} color={SUCCESS} />
    case 'think':
      return <Brain size={size} color={DEFAULT} />
    case 'fetch':
      return <Globe size={size} color={VARIABLE} />
    case 'switch_mode':
      return <Repeat size={size} color={CALLABLE} />
    case 'other':
      return <Wrench size={size} color={DEFAULT} />
    default:
      return <CircleHelp size={size} color={DEFAULT} />
  }
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
