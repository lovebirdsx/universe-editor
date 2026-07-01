/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Selection context — editor selections the user explicitly attaches to a
 *  prompt as context (Cursor's Ctrl+L / Copilot's "Add Selection to Chat").
 *
 *  Unlike an @-mention (a `resource_link` that only names a file and lets the
 *  agent read the whole thing), a selection carries the *actual selected text*
 *  plus its line range — a `resource_link` has no range field, so it cannot
 *  express "just these lines". The wire shape depends on the agent's advertised
 *  `promptCapabilities.embeddedContext`:
 *    - supported → an `EmbeddedResource` (`type:'resource'`) whose
 *      `TextResourceContents` holds the uri + text; the 1-based line range rides
 *      in `_meta.selection` so a capable agent can locate the snippet.
 *    - not supported → a plain text block with a fenced code block whose info
 *      string is `<lang> <relPath>:<start>-<end>`. Any agent understands this,
 *      so nothing is lost, only structure.
 *--------------------------------------------------------------------------------------------*/

import type { ContentBlock } from '@agentclientprotocol/sdk'

export interface SelectionContext {
  /** Absolute URI of the source file (typically `file:///...`). */
  readonly uri: string
  /** Workspace-relative path, used for display and the fallback fence header. */
  readonly relPath: string
  /** The selected text, snapshotted when the context was attached. */
  readonly text: string
  /** 1-based inclusive start line of the selection. */
  readonly startLine: number
  /** 1-based inclusive end line of the selection. */
  readonly endLine: number
  /** Monaco language id, used for the fence info string and the resource mimeType. */
  readonly languageId?: string
}

/** `file.ts:12-40`, or `file.ts:12` for a single line. Display + fence header. */
export function formatSelectionLabel(ctx: {
  readonly relPath: string
  readonly startLine: number
  readonly endLine: number
}): string {
  const range =
    ctx.startLine === ctx.endLine ? `${ctx.startLine}` : `${ctx.startLine}-${ctx.endLine}`
  return `${ctx.relPath}:${range}`
}

/**
 * Turn attached selections into ContentBlocks to prepend before the user's
 * message. Returns an EmbeddedResource per selection when the agent supports
 * `embeddedContext`, else a fenced-code text block. Empty input → `[]`.
 */
export function composeContextBlocks(
  contexts: readonly SelectionContext[],
  embeddedSupported: boolean,
): readonly ContentBlock[] {
  if (contexts.length === 0) return []
  if (embeddedSupported) {
    return contexts.map((ctx) => ({
      type: 'resource',
      resource: {
        uri: ctx.uri,
        text: ctx.text,
        ...(ctx.languageId !== undefined ? { mimeType: mimeTypeForLanguage(ctx.languageId) } : {}),
      },
      _meta: { selection: { startLine: ctx.startLine, endLine: ctx.endLine } },
    }))
  }
  return contexts.map((ctx) => ({ type: 'text', text: formatSelectionFallback(ctx) }))
}

/** Fenced code block carrying the selection for agents without `embeddedContext`. */
export function formatSelectionFallback(ctx: SelectionContext): string {
  const header = `${ctx.languageId ?? ''} ${formatSelectionLabel(ctx)}`.trim()
  return `\`\`\`${header}\n${ctx.text}\n\`\`\``
}

function mimeTypeForLanguage(languageId: string): string {
  return MIME_BY_LANGUAGE[languageId] ?? 'text/plain'
}

const MIME_BY_LANGUAGE: Record<string, string> = {
  typescript: 'text/x-typescript',
  javascript: 'text/javascript',
  typescriptreact: 'text/x-typescript',
  javascriptreact: 'text/javascript',
  json: 'application/json',
  markdown: 'text/markdown',
  css: 'text/css',
  html: 'text/html',
}
