/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Local WSL detection and distro enumeration for the remote-target picker.
 *  wsl.exe prints UTF-16LE by default and localizes the `--verbose` STATE column,
 *  so the running set comes from a separate `--list --running --quiet` call and
 *  parsing never touches STATE text (VSCode-remote experience). Any failure
 *  (WSL absent, timeout, non-win32) degrades to an empty list.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isValidWslDistroName } from '@universe-editor/platform'
import type { WslDistroDto } from '../../../shared/ipc/remoteStatusService.js'

const WSL_TIMEOUT_MS = 3000

export function getWslExePath(): string | undefined {
  if (process.platform !== 'win32') return undefined
  const windir = process.env['windir'] ?? 'C:\\Windows'
  // A 32-bit process on a 64-bit OS only sees the WoW64 System32; Sysnative is
  // the escape hatch to the real 64-bit wsl.exe.
  const systemDir = process.env['PROCESSOR_ARCHITEW6432'] ? 'Sysnative' : 'System32'
  const wslPath = join(windir, systemDir, 'wsl.exe')
  return existsSync(wslPath) ? wslPath : undefined
}

export function isWslAvailable(): boolean {
  return getWslExePath() !== undefined
}

export type WslExecFile = (
  file: string,
  args: readonly string[],
  options: { encoding: 'utf16le'; timeout: number; env: NodeJS.ProcessEnv },
) => Promise<string>

const defaultWslExecFile: WslExecFile = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: options.encoding, timeout: options.timeout, env: options.env, shell: false },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      },
    )
  })

export interface WslTargetsDeps {
  readonly execFile?: WslExecFile
  readonly wslExePath?: string
  readonly log?: (message: string) => void
}

export async function listWslDistros(deps: WslTargetsDeps = {}): Promise<WslDistroDto[]> {
  const wslPath = deps.wslExePath ?? getWslExePath()
  if (!wslPath) return []
  const exec = deps.execFile ?? defaultWslExecFile
  const options = {
    encoding: 'utf16le' as const,
    timeout: WSL_TIMEOUT_MS,
    // Force UTF-16LE output even when the user enabled WSL_UTF8 globally.
    env: { ...process.env, WSL_UTF8: '0' },
  }
  try {
    const [verbose, running] = await Promise.all([
      exec(wslPath, ['--list', '--verbose'], options),
      exec(wslPath, ['--list', '--running', '--quiet'], options),
    ])
    return parseWslDistros(verbose, running)
  } catch (err) {
    deps.log?.(`WSL distro enumeration failed: ${(err as Error).message}`)
    return []
  }
}

function cleanLines(output: string): string[] {
  return output
    .replace(/[\uFEFF\0]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/** Exported for tests: pure parse of `--list --verbose` + `--list --running --quiet`. */
export function parseWslDistros(verboseOutput: string, runningOutput: string): WslDistroDto[] {
  const running = new Set(cleanLines(runningOutput))
  const distros: WslDistroDto[] = []
  const lines = cleanLines(verboseOutput)
  for (const [index, line] of lines.entries()) {
    // Header row: locale-independent check on the NAME column marker.
    if (index === 0 && line.toUpperCase().startsWith('NAME')) continue
    const isDefault = line.startsWith('*')
    const row = isDefault ? line.slice(1).trim() : line
    const columns = row.split(/\s+/)
    if (columns.length < 3) continue
    const name = columns[0]!
    const version = Number.parseInt(columns[columns.length - 1]!, 10)
    if (Number.isNaN(version)) continue
    if (name.startsWith('docker-desktop')) continue
    if (!isValidWslDistroName(name)) continue
    distros.push({ name, isDefault, isRunning: running.has(name), version })
  }
  distros.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return distros
}
