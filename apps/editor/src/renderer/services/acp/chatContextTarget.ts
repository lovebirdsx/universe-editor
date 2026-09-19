/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Chat context-menu target resolution — maps the DOM node under the cursor
 *  (or a menu command arg) to a typed copy target: an image block, a resource
 *  link, or a selection-context chip. The `data-uri` / `data-context-text`
 *  attributes are stamped by the rendering components; this module is the
 *  single read side so menu actions and context-key seeding stay in sync.
 *
 *  Also the read side of the timeline menu's *slot* payload — which card the
 *  menu was raised on. A card and a fragment are independent halves of the same
 *  arg object (right-clicking a selection inside a sub-agent card has both), and
 *  each command reads only its half: the copy actions take {@link readContextTarget},
 *  the card actions {@link readChatContextArg}.
 *--------------------------------------------------------------------------------------------*/

export type AcpContextMenuTarget =
  | { readonly kind: 'image'; readonly src: string }
  | { readonly kind: 'path'; readonly uri: string }
  | { readonly kind: 'text'; readonly text: string }

/**
 * Walk up from `el` to the nearest copy-able chat fragment, most specific
 * first: an image nested inside a resource link resolves as the image.
 */
export function resolveChatContextTarget(el: HTMLElement): AcpContextMenuTarget | undefined {
  const image = el.closest('[data-testid="acp-image-block"]')
  if (image) {
    const src = image.getAttribute('src')
    if (src) return { kind: 'image', src }
  }
  const link = el.closest('[data-testid="acp-resource-link"]')
  if (link) {
    const uri = link.getAttribute('data-uri')
    if (uri) return { kind: 'path', uri }
  }
  const chip = el.closest('[data-testid="acp-selection-context-chip"]')
  if (chip) {
    const text = chip.getAttribute('data-context-text')
    if (text) return { kind: 'text', text }
  }
  // Generic fallback, deliberately last so it cannot shadow any branch above:
  // anything stamped with a resolved `data-uri` (an inline diff's path button, a
  // tool call's file location) is copyable as a path without a per-component
  // branch here.
  const pathEl = el.closest('[data-uri]')
  const uri = pathEl?.getAttribute('data-uri')
  if (uri) return { kind: 'path', uri }
  return undefined
}

/**
 * Extract a validated {@link AcpContextMenuTarget} from a menu command arg of
 * the shape `{ sessionId, target? }`. Field-by-field validation — anything
 * malformed degrades to `undefined` rather than crashing the command.
 */
export function readContextTarget(arg: unknown): AcpContextMenuTarget | undefined {
  if (typeof arg !== 'object' || arg === null) return undefined
  const target = (arg as Record<string, unknown>)['target']
  if (typeof target !== 'object' || target === null) return undefined
  const record = target as Record<string, unknown>
  switch (record['kind']) {
    case 'image': {
      const src = record['src']
      return typeof src === 'string' && src.length > 0 ? { kind: 'image', src } : undefined
    }
    case 'path': {
      const uri = record['uri']
      return typeof uri === 'string' && uri.length > 0 ? { kind: 'path', uri } : undefined
    }
    case 'text': {
      const text = record['text']
      return typeof text === 'string' && text.length > 0 ? { kind: 'text', text } : undefined
    }
    default:
      return undefined
  }
}

/** Which read affordance an agent-created file offers: a rendered preview
 *  (markdown / html) or the plain editor. */
export type AcpCreatedFileKind = 'preview' | 'open'

/**
 * The *card* the timeline context menu was raised on — orthogonal to
 * {@link AcpContextMenuTarget}, which describes the fragment under the cursor
 * (a card and a fragment can both be present: right-clicking a selection inside
 * a sub-agent card). Resolved by the rendering side (it owns the DOM keys and
 * the collapse store) into the shape the menu `when` clauses read.
 */
export interface AcpChatSlot {
  /** Composite sticky key; a nested sub-agent child reads `t:parent/t:child`. */
  readonly slotKey: string
  /** Rewind / fork anchor of a user message turn — absent for every other card. */
  readonly messageId: string | undefined
  /** Foldable card (message / tool call); status bars are not. */
  readonly card: boolean
  readonly collapsed: boolean
  readonly userMessage: boolean
  /** Tool call carrying a nested sub-agent timeline. */
  readonly subAgent: boolean
  /** The card itself lives inside a sub-agent timeline. */
  readonly nested: boolean
  readonly createdFile: AcpCreatedFileKind | undefined
}

/**
 * The menu-arg payload shared by both timeline context-menu hosts (ChatBody and
 * the sticky user-message bar). Carries identity only — never content — so a
 * command resolves what it needs from the session model at run time: a
 * sub-agent transcript can be megabytes, and folding state read from the widget
 * is always current instead of a snapshot taken when the menu opened.
 *
 * `messageId` sits at the top level on purpose: that is exactly what
 * `RewindAgentSessionAction` / `ForkAgentSessionAction` already read, so both
 * stay untouched by the menu wiring.
 */
export interface AcpChatContextArg {
  readonly sessionId: string | undefined
  readonly slotKey: string | undefined
  readonly messageId: string | undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Extract a validated {@link AcpChatContextArg} from a menu command arg.
 * Field-by-field validation, same contract as {@link readContextTarget}: a
 * malformed field degrades to `undefined` instead of crashing the command.
 * Fields are typed `T | undefined` rather than optional — under
 * `exactOptionalPropertyTypes` a present-but-undefined property is not
 * assignable to `prop?: T`, and every reader has to check anyway.
 */
export function readChatContextArg(arg: unknown): AcpChatContextArg {
  if (typeof arg !== 'object' || arg === null) {
    return { sessionId: undefined, slotKey: undefined, messageId: undefined }
  }
  const record = arg as Record<string, unknown>
  return {
    sessionId: nonEmptyString(record['sessionId']),
    slotKey: nonEmptyString(record['slotKey']),
    messageId: nonEmptyString(record['messageId']),
  }
}
