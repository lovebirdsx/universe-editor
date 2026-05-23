/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Parser for slash-command wrapper tags Claude Code (and similarly-built
 *  agents) emit into their session history when they execute a local slash
 *  command. The agent stores something like:
 *
 *    <command-name>/model</command-name>
 *    <command-message>model</command-message>
 *    <command-args>default</command-args>
 *    <local-command-stdout>Set model to claude-sonnet-4-6</local-command-stdout>
 *
 *  On `session/load` the agent replays that text back via `user_message_chunk`,
 *  so the client sees it as part of the user message blocks. Rather than
 *  rendering raw XML, we parse the wrappers out and let the renderer show a
 *  compact "command invocation" badge in their place.
 *
 *  Parsing rules:
 *    - `<command-name>` is the anchor — every other tag is optional and
 *      attached to the nearest preceding anchor.
 *    - Optional tags may appear in any order, separated by whitespace only.
 *    - The block ends at the first non-whitespace, non-wrapper character; that
 *      character belongs to the next text segment (or to the next invocation
 *      if it starts a fresh `<command-name>`).
 *    - Unclosed or malformed wrappers fall through as plain text — the parser
 *      never throws, since the input is untrusted agent output.
 *--------------------------------------------------------------------------------------------*/

export interface CommandInvocation {
  readonly name: string
  readonly message?: string
  readonly args?: string
  readonly stdout?: string
}

export type ParsedSegment =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'command'; readonly invocation: CommandInvocation }

const NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/g

interface OptionalTag {
  readonly key: 'message' | 'args' | 'stdout'
  readonly open: string
  readonly close: string
}

const OPTIONAL_TAGS: readonly OptionalTag[] = [
  { key: 'message', open: '<command-message>', close: '</command-message>' },
  { key: 'args', open: '<command-args>', close: '</command-args>' },
  { key: 'stdout', open: '<local-command-stdout>', close: '</local-command-stdout>' },
]

/**
 * Split a string into ordered prose / command-invocation segments. Returns a
 * single `text` segment when no wrappers are found, and an empty array only
 * when the input is empty.
 */
export function parseCommandWrappers(text: string): readonly ParsedSegment[] {
  if (text.length === 0) return []
  const out: ParsedSegment[] = []
  NAME_RE.lastIndex = 0
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = NAME_RE.exec(text)) !== null) {
    const anchorStart = match.index
    const anchorEnd = NAME_RE.lastIndex
    if (anchorStart > cursor) {
      out.push({ type: 'text', text: text.slice(cursor, anchorStart) })
    }
    const name = match[1]!.trim()
    let blockEnd = anchorEnd
    let message: string | undefined
    let args: string | undefined
    let stdout: string | undefined
    let extended = true
    while (extended) {
      extended = false
      // Skip whitespace between adjacent tags. The agent emits one tag per line
      // but we don't depend on that — any whitespace run counts.
      let probe = blockEnd
      while (probe < text.length && /\s/.test(text[probe]!)) probe++
      for (const tag of OPTIONAL_TAGS) {
        if (!text.startsWith(tag.open, probe)) continue
        const contentStart = probe + tag.open.length
        const closeIdx = text.indexOf(tag.close, contentStart)
        if (closeIdx === -1) continue
        const content = text.slice(contentStart, closeIdx)
        if (tag.key === 'message' && message === undefined) message = content
        else if (tag.key === 'args' && args === undefined) args = content
        else if (tag.key === 'stdout' && stdout === undefined) stdout = content
        else continue
        blockEnd = closeIdx + tag.close.length
        extended = true
        break
      }
    }
    out.push({
      type: 'command',
      invocation: {
        name,
        ...(message !== undefined ? { message } : {}),
        ...(args !== undefined ? { args } : {}),
        ...(stdout !== undefined ? { stdout } : {}),
      },
    })
    cursor = blockEnd
    NAME_RE.lastIndex = blockEnd
  }
  if (cursor < text.length) {
    out.push({ type: 'text', text: text.slice(cursor) })
  }
  return out
}
