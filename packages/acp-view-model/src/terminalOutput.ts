/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Read the codex-acp fork's out-of-band terminal output from a tool_call(_update).
 *  The fork streams command output via `_meta.terminal_output_delta` (append-only
 *  chunks) or `_meta.terminal_output` (a full snapshot), rather than as `content`
 *  blocks. Pure so both the editor session layer and the mobile bridge share it.
 *--------------------------------------------------------------------------------------------*/

import type { SessionUpdate } from '@agentclientprotocol/sdk'

/**
 * Returns the chunk plus whether it appends to or replaces the accumulator, or
 * undefined when this update carries no terminal output.
 */
export function readTerminalOutput(
  update: SessionUpdate,
): { readonly data: string; readonly mode: 'append' | 'replace' } | undefined {
  const meta = (
    update as {
      _meta?: {
        terminal_output_delta?: { data?: unknown } | null
        terminal_output?: { data?: unknown } | null
      } | null
    }
  )._meta
  if (!meta) return undefined
  const delta = meta.terminal_output_delta?.data
  if (typeof delta === 'string') return { data: delta, mode: 'append' }
  const full = meta.terminal_output?.data
  if (typeof full === 'string') return { data: full, mode: 'replace' }
  return undefined
}
