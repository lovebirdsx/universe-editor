/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Explicit cmd.exe wrapper for Windows spawns that need shell resolution
 *  (`.cmd`/`.bat` shims like `npx` cannot be exec'd directly). Replaces
 *  `spawn(..., { shell: true })`, whose unescaped args concatenation triggers
 *  DEP0190 and is a command-injection hazard.
 *
 *  Electron-free, shared by apps/editor main and the remote server daemon.
 *--------------------------------------------------------------------------------------------*/

import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type StdioOptions,
} from 'node:child_process'

/** Quote one token for a cmd.exe command line: wrap in `"`, doubling inner quotes. */
export function quoteCmdArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/**
 * A command name cmd.exe would read as something other than a plain word goes
 * out quoted: whitespace splits it, `&|<>()` chain or redirect, `^` escapes,
 * `"` re-quotes, `%`/`!` expand. Real paths land here too —
 * `C:\Programs(x86)\x.exe` used to go bare, its parenthesis running as shell
 * syntax. Quoting costs the `%~dp0` resolution explained below, which cannot
 * bite: a name like this is never a PATH shim.
 */
const CMD_NAME_NEEDS_QUOTING = /[\s&|<>^()"%!]/

/**
 * Assemble the single command line for `cmd.exe /d /s /c`.
 *
 * A bare command name is deliberately left unquoted so the line never *starts*
 * with `"`. When it does, cmd takes the `/s` form, strips the first and last
 * quote, and then resolves the name from PATH with `%0` set to the bare name —
 * no directory part, so a `.cmd` shim's `%~dp0` expands to the *cwd* instead of
 * its own directory. The shim then cannot find the sibling file it launches:
 * `code.cmd` looking for `Code.exe` exits 9009, and the caller sees a clean
 * spawn (the cmd.exe wrapper really did start) and reports success.
 *
 * A command name containing whitespace or any of the metacharacters above can
 * only be quoted, so it keeps the outer-quoted form. `.exe` targets still work
 * there — an absolute path puts its directory into `%0` — while `.cmd` shims
 * under a spaced path are a cmd limitation we cannot route around.
 */
export function buildCmdCommandLine(command: string, args: readonly string[]): string {
  if (CMD_NAME_NEEDS_QUOTING.test(command)) {
    return `"${[command, ...args].map(quoteCmdArg).join(' ')}"`
  }
  const quotedArgs = args.map(quoteCmdArg).join(' ')
  return args.length > 0 ? `${command} ${quotedArgs}` : command
}

export interface CmdSpawnOptions {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv | undefined
  readonly stdio?: StdioOptions
  readonly detached?: boolean
}

/**
 * Spawn `command` through cmd.exe with properly quoted arguments.
 * `windowsVerbatimArguments` stops Node from re-escaping our pre-quoted line.
 */
export function spawnViaCmd(
  command: string,
  args: readonly string[],
  options?: CmdSpawnOptions & { readonly stdio?: undefined },
): ChildProcessWithoutNullStreams
export function spawnViaCmd(
  command: string,
  args: readonly string[],
  options: CmdSpawnOptions,
): ChildProcess
export function spawnViaCmd(
  command: string,
  args: readonly string[],
  options: CmdSpawnOptions = {},
): ChildProcess {
  const comspec = process.env['COMSPEC'] ?? 'cmd.exe'
  return spawn(comspec, ['/d', '/s', '/c', buildCmdCommandLine(command, args)], {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'],
    ...(options.detached !== undefined ? { detached: options.detached } : {}),
    windowsHide: true,
    windowsVerbatimArguments: true,
  })
}
