/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Positional-argument parsing for startup / second-instance launches. Kept separate
 *  from index.ts (which pulls in electron) so it can be unit-tested in the node env.
 *--------------------------------------------------------------------------------------------*/

import { isDeepLink } from '../shared/deepLink.js'
import { CLI_OPTIONS } from './environment/configItems.js'

// Flags that consume the following token as their value (`--flag value` /
// `-a value`). Derived from CLI_OPTIONS so a new valued option is handled here
// automatically. Boolean flags never consume the next token. The `--flag=value`
// form is self-contained and needs no entry here (it starts with `-`).
const VALUED_FLAGS: ReadonlySet<string> = (() => {
  const set = new Set<string>()
  for (const item of CLI_OPTIONS) {
    if (!item.cli || item.type === 'boolean') continue
    set.add(`--${item.cli}`)
    if (item.cliAlias) set.add(`-${item.cliAlias}`)
  }
  return set
})()

/**
 * `--quit` asks an already-running instance to exit (File → Exit equivalent).
 * A second launch only forwards the flag; the primary instance calls app.quit().
 * Kept value-less so it never consumes a following path.
 */
export function hasQuitFlag(argv: readonly string[]): boolean {
  return argv.includes('--quit')
}

/**
 * `--agent-sessions` asks a running instance to print a live agent-session
 * snapshot as JSON on stdout and exit. A second launch forwards the flag and
 * advertises a response pipe through `requestSingleInstanceLock(additionalData)`;
 * with no running instance the flag prints an empty list.
 */
export function hasAgentSessionsFlag(argv: readonly string[]): boolean {
  return argv.includes('--agent-sessions')
}

/**
 * Extract the first positional argument (a file or directory to open at startup).
 * Windows file associations pass the path as a plain argv entry.
 *
 * Skips both flags and the values consumed by valued flags — otherwise the value
 * of e.g. `--user-data-dir <path>` (space form) would be mistaken for a folder to
 * open. Matches CliConfigSource's consumption rule: a valued flag consumes the
 * next token only when it does not itself start with `-`.
 *
 * Packaged: argv[0]=exe, argv[1+]=user args.
 * Dev:      argv[0]=electron, argv[1]=main script, argv[2+]=user args.
 */
export function parseFileToOpen(argv: readonly string[], isPackaged: boolean): string | undefined {
  const args = argv.slice(isPackaged ? 1 : 2)
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a.startsWith('-')) {
      if (VALUED_FLAGS.has(a)) {
        const next = args[i + 1]
        if (next !== undefined && !next.startsWith('-')) i++ // skip the consumed value token
      }
      continue
    }
    if (a.length > 0 && !isDeepLink(a)) return a
  }
  return undefined
}
