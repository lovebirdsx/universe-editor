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
