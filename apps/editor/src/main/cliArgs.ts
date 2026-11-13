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
 * `--quit-skip-session=<agentSessionId>` exempts one session from the quit
 * confirmation prompt. The refresh-installed-editor skill names the session
 * that initiated the quit (its own `CLAUDE_CODE_SESSION_ID`); every other
 * running session still prompts. Kept `=`-only so it never eats a path token.
 */
export function parseQuitSkipSession(argv: readonly string[]): string | undefined {
  const prefix = '--quit-skip-session='
  for (const arg of argv) {
    if (!arg.startsWith(prefix)) continue
    const id = arg.slice(prefix.length).trim()
    return id.length > 0 ? id : undefined
  }
  return undefined
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
 * `--background` is passed by the OS login item. A second launch carrying only
 * this flag (no file/folder/deep link) must be ignored instead of opening a
 * window; a cold launch decides separately whether background mode is active.
 */
export function hasBackgroundFlag(argv: readonly string[]): boolean {
  return argv.includes('--background')
}

/**
 * Explorer builds the directory command as `"<exe>" "%V"`. At a drive root
 * `%V` is `D:\`, so the trailing backslash escapes the closing quote and argv
 * receives `D:"`. Windows file names cannot contain `"`, so dropping it is
 * lossless; the bare drive left behind is the selected root. Quote-free tokens
 * keep their Win32 drive-relative meaning (`ue D:` = current directory on D:).
 */
function repairWindowsArgvToken(token: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32' || !token.includes('"')) return token
  const unquoted = token.replaceAll('"', '')
  return /^[a-zA-Z]:$/.test(unquoted) ? `${unquoted}\\` : unquoted
}

/**
 * Index of the app's main script in default-app (dev) mode. Electron/Node/
 * Chromium switches — including ones injected by tooling such as Playwright's
 * `--inspect=0 --remote-debugging-port=0` — precede it, so it is the first
 * non-switch token after argv[0]; user args follow it.
 */
function appEntryIndex(argv: readonly string[]): number {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!
    if (a.length > 0 && !a.startsWith('-')) return i
  }
  return -1
}

/** The main-script path in default-app (dev) mode; undefined when absent. */
export function findAppEntryPath(argv: readonly string[]): string | undefined {
  const index = appEntryIndex(argv)
  return index === -1 ? undefined : argv[index]
}

/**
 * Index of the first user argument. Packaged: argv[0] is the executable, so
 * user args start at argv[1]. Dev: args start after the main script (see
 * appEntryIndex) — a fixed slice(2) breaks as soon as switches precede it.
 */
function userArgsStart(argv: readonly string[], isPackaged: boolean): number {
  if (isPackaged) return 1
  const index = appEntryIndex(argv)
  return index === -1 ? argv.length : index + 1
}

/**
 * Extract the first positional argument (a file or directory to open at startup).
 * Windows file associations pass the path as a plain argv entry; a drive/UNC
 * root arrives mangled by Explorer's quoted `%V` template and is repaired.
 *
 * Skips both flags and the values consumed by valued flags — otherwise the value
 * of e.g. `--user-data-dir <path>` (space form) would be mistaken for a folder to
 * open. Matches CliConfigSource's consumption rule: a valued flag consumes the
 * next token only when it does not itself start with `-`.
 *
 * Packaged: argv[0]=exe, argv[1+]=user args.
 * Dev:      argv[0]=electron, [switches…], entry script, user args.
 */
export function parseFileToOpen(
  argv: readonly string[],
  isPackaged: boolean,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const args = argv.slice(userArgsStart(argv, isPackaged))
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a.startsWith('-')) {
      if (VALUED_FLAGS.has(a)) {
        const next = args[i + 1]
        if (next !== undefined && !next.startsWith('-')) i++ // skip the consumed value token
      }
      continue
    }
    if (a.length > 0 && !isDeepLink(a)) return repairWindowsArgvToken(a, platform)
  }
  return undefined
}
