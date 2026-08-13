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
 * Assemble the single command line for `cmd.exe /d /s /c`. The whole line is
 * wrapped in an extra pair of quotes: with `/s`, cmd strips exactly the first
 * and last quote character and parses the remainder — the classic libuv-safe
 * form that keeps inner quoting intact.
 */
export function buildCmdCommandLine(command: string, args: readonly string[]): string {
  const inner = [command, ...args].map(quoteCmdArg).join(' ')
  return `"${inner}"`
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
