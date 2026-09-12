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

export function redactProcessName(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (ROLE_NAME_RE.test(trimmed)) return trimmed
  const quoted = /^"([^"]+)"/.exec(trimmed)?.[1]
  const head = quoted ?? trimmed.split(/\s+/)[0] ?? ''
  const stem = head.split(/[\\/]/).filter(Boolean).pop() ?? ''
  return EXECUTABLE_STEM_RE.test(stem) ? stem : undefined
}
