/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  acpTimelineOutline — pure conversion of an ACP session timeline into the
 *  DocumentSymbol tree the Outline view consumes, so a full-screen agent session
 *  gets an outline the same way a file or a markdown preview does.
 *
 *  Conversation grouping — the outline mirrors the turn structure rather than the
 *  flat timeline. A user message opens a parent scope and every following
 *  non-user item nests under it; an agent message opens a child scope and every
 *  following non-agent item (tool calls, thoughts) nests under it. So a turn reads
 *  as:
 *    user message                (parent)
 *      agent message             (child)
 *        tool call               (grandchild)
 *      agent message
 *        tool call
 *    user message
 *      agent message
 *  Items before the first user / agent (an opening tool call, say) stay at the
 *  level they belong to. Grouping only re-nests contiguous runs — it never
 *  reorders — so a node's subtree is always a contiguous slice of the timeline.
 *
 *  Sub-agent items (a tool call's `children`, e.g. a Task spawning a subagent) are
 *  a *different* nesting: they are real DOM sub-cards, so they keep their
 *  `/`-composed sticky key. The conversation grouping above is purely visual — a
 *  grouped child is still a top-level chat card, so it keeps its plain `m:`/`t:`
 *  slot key.
 *
 *  The outline is line-based (DocumentSymbol.range), but a timeline is key-based
 *  (`m:<id>` / `t:<id>`). We assign each item a monotonic pseudo-line in timeline
 *  order and return the key↔line maps so OutlineService can bridge the two: a
 *  reveal turns a symbol's line back into a slot key, and the active symbol turns
 *  the active slot key into a line. Because every subtree is a contiguous timeline
 *  slice, a parent's range spans down to its last descendant unbroken, so
 *  findSymbolAtLine resolves the deepest item and follow-cursor expands ancestors.
 *--------------------------------------------------------------------------------------------*/

import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'
import { blocksToText } from './acpSessionContent.js'
import type { AcpChildItem, AcpMessageRole, TimelineItem } from './acpSessionModel.js'
import { buildStickyKey, itemSlotKey } from '../../workbench/agents/stickyScroll.js'

/** Language id published on the OutlineModel so symbolIcon can special-case agent-session rows. */
export const ACP_OUTLINE_LANGUAGE_ID = 'acp.session'

// Message roles, ordered — the index is the DocumentSymbol.kind for a message row.
const MESSAGE_ROLE_ORDER: readonly AcpMessageRole[] = ['user', 'agent', 'thought']

// Tool-call kinds symbolIcon can draw a glyph for, ordered. A tool row's kind is
// `TOOL_KIND_BASE + index`; unknown kinds fall back to the last (`other`) slot.
const TOOL_KIND_ORDER = [
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

const TOOL_KIND_BASE = 100

function encodeMessageKind(role: AcpMessageRole): number {
  const i = MESSAGE_ROLE_ORDER.indexOf(role)
  return i >= 0 ? i : 1 // default to `agent`
}

function encodeToolKind(kind: string): number {
  const i = (TOOL_KIND_ORDER as readonly string[]).indexOf(kind)
  return TOOL_KIND_BASE + (i >= 0 ? i : TOOL_KIND_ORDER.indexOf('other'))
}

/** Decode an acp.session DocumentSymbol.kind back into the role / tool-kind it encodes. */
export function decodeAcpOutlineKind(
  kind: number,
):
  | { readonly type: 'message'; readonly role: AcpMessageRole }
  | { readonly type: 'tool'; readonly kind: string } {
  if (kind >= TOOL_KIND_BASE) {
    return { type: 'tool', kind: TOOL_KIND_ORDER[kind - TOOL_KIND_BASE] ?? 'other' }
  }
  return { type: 'message', role: MESSAGE_ROLE_ORDER[kind] ?? 'agent' }
}

const MAX_LABEL = 120

/** First non-empty line of `text`, trimmed and clamped — mirrors ChatBody.firstLineSummary. */
function summarize(text: string): string {
  const firstLine = text.split('\n', 1)[0]?.trim() ?? ''
  return firstLine.length > MAX_LABEL ? `${firstLine.slice(0, MAX_LABEL)}…` : firstLine
}

function itemLabel(item: TimelineItem | AcpChildItem): string {
  if (item.kind === 'message') {
    const summary = summarize(item.message.text || blocksToText(item.message.blocks))
    return summary.length > 0 ? summary : item.message.role
  }
  return item.call.title.length > 0 ? item.call.title : item.call.kind
}

function itemKind(item: TimelineItem | AcpChildItem): number {
  return item.kind === 'message'
    ? encodeMessageKind(item.message.role)
    : encodeToolKind(item.call.kind)
}

function range(startLine: number, endLine: number): monaco.IRange {
  return { startLineNumber: startLine, startColumn: 1, endLineNumber: endLine, endColumn: 1 }
}

export interface TimelineOutline {
  readonly roots: monaco.languages.DocumentSymbol[]
  /** Pseudo-line (1-based) → slot key, for turning the active symbol into a reveal target. */
  readonly keyByLine: ReadonlyMap<number, string>
  /** Slot key → pseudo-line, for turning the top-visible slot into an active symbol. */
  readonly lineByKey: ReadonlyMap<string, number>
}

/**
 * Build the outline for a timeline, grouping it into the conversation's turn
 * structure (see the file header): a user message parents every following
 * non-user item; an agent message parents every following non-agent item. Each
 * item (and each sub-agent child) gets a pseudo-line in timeline order; because
 * grouping only re-nests contiguous runs, a node's subtree is always a contiguous
 * slice, so a parent's `range` spans down to its last descendant unbroken and
 * findSymbolAtLine resolves the deepest item under a given line. Top-level chat
 * cards keep their plain `m:`/`t:` slot key even when grouped; only true sub-agent
 * children get a `/`-composed key (see buildStickyKey) so a reveal resolves them.
 */
export function timelineToOutline(timeline: readonly TimelineItem[]): TimelineOutline {
  const keyByLine = new Map<number, string>()
  const lineByKey = new Map<string, number>()
  let line = 0

  // A mutable node while we assemble the tree; converted to DocumentSymbol once
  // the full subtree (and thus its end line) is known.
  interface BuildNode {
    readonly name: string
    readonly kind: number
    readonly startLine: number
    readonly children: BuildNode[]
  }

  const record = (key: string): number => {
    const startLine = ++line
    keyByLine.set(startLine, key)
    lineByKey.set(key, startLine)
    return startLine
  }

  // Sub-agent children are real nested cards: composed keys, kept as-is.
  const buildSubAgent = (items: readonly AcpChildItem[], parentKey: string): BuildNode[] =>
    items.map((item) => {
      const key = buildStickyKey(parentKey, item)
      const startLine = record(key)
      const children =
        item.kind === 'toolCall' && item.call.children && item.call.children.length > 0
          ? buildSubAgent(item.call.children, key)
          : []
      return { name: itemLabel(item), kind: itemKind(item), startLine, children }
    })

  // One node per top-level timeline card, with its sub-agent subtree nested.
  const buildCard = (item: TimelineItem): BuildNode => {
    const key = itemSlotKey(item)
    const startLine = record(key)
    const children =
      item.kind === 'toolCall' && item.call.children && item.call.children.length > 0
        ? buildSubAgent(item.call.children, key)
        : []
    return { name: itemLabel(item), kind: itemKind(item), startLine, children }
  }

  const roots: BuildNode[] = []
  let userParent: BuildNode | undefined
  let agentParent: BuildNode | undefined

  for (const item of timeline) {
    const node = buildCard(item)
    const role = item.kind === 'message' ? item.message.role : undefined
    if (role === 'user') {
      roots.push(node)
      userParent = node
      agentParent = undefined
    } else if (role === 'agent') {
      ;(userParent?.children ?? roots).push(node)
      agentParent = node
    } else {
      // Tool call or thought: nest under the open agent turn, else the open user
      // turn, else stand alone (an item before any message).
      ;(agentParent?.children ?? userParent?.children ?? roots).push(node)
    }
  }

  // A subtree is a contiguous line slice, so each node's end line is the max end
  // among itself and its descendants.
  const finalize = (node: BuildNode): monaco.languages.DocumentSymbol => {
    const children = node.children.map(finalize)
    const endLine = children.reduce(
      (max, c) => Math.max(max, c.range.endLineNumber),
      node.startLine,
    )
    return {
      name: node.name,
      detail: '',
      kind: node.kind as monaco.languages.SymbolKind,
      tags: [],
      range: range(node.startLine, endLine),
      selectionRange: range(node.startLine, node.startLine),
      children,
    }
  }

  return { roots: roots.map(finalize), keyByLine, lineByKey }
}
