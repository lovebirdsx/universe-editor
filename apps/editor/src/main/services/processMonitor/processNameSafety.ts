/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  One rule with two callers: the process tree writes child names into
 *  `processMetrics.log` (and from there into diagnostics bundles), and the
 *  death-scene reader parses those names back out on the next launch.
 *
 *  `findName` keeps the raw command line as its fallback so the process explorer
 *  can show it, but a command line carries credentials in its arguments
 *  (`--mcp-config '{"env":{"API_KEY":…}}'`) and must never reach a log file. Only
 *  two shapes survive: a role name the registry produced (`window (window-4)`,
 *  `tsserver`) or a bare executable stem (`cmd.exe`). When even the stem cannot be
 *  recovered — the first token is `--api-key=…` — the answer is `undefined`, not a
 *  guess.
 *--------------------------------------------------------------------------------------------*/

const ROLE_NAME_RE = /^[A-Za-z0-9_.-]+(?: \([A-Za-z0-9_. -]+\))?$/
const EXECUTABLE_STEM_RE = /^[A-Za-z0-9_.-]+$/

/**
 * Marker the metrics writer puts in front of a hosted process that the user launched
 * (an integrated-terminal shell and everything under it). The death-scene reader strips
 * it before redacting, so the marker survives the round trip without becoming part of
 * the process name. Windows file names cannot contain `:`, so no real name collides.
 */
export const USER_PROCESS_PREFIX = 'user:'

export function redactProcessName(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (ROLE_NAME_RE.test(trimmed)) return trimmed
  const quoted = /^"([^"]+)"/.exec(trimmed)?.[1]
  const head = quoted ?? trimmed.split(/\s+/)[0] ?? ''
  const stem = head.split(/[\\/]/).filter(Boolean).pop() ?? ''
  return EXECUTABLE_STEM_RE.test(stem) ? stem : undefined
}
