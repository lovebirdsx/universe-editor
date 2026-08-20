/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Post-deploy dependency install for the remote server bundle. Lives outside
 *  bootstrap.ts on purpose: bootstrap.js statically imports native packages
 *  (@vscode/ripgrep etc.) that only exist after this install has run — the
 *  install entry must stay free of external imports so it can run on a freshly
 *  extracted bundle with no node_modules.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnViaCmd } from '@universe-editor/node-services'

export const BUNDLE_HASH_FILE = 'bundle.hash'

export interface NpmRunResult {
  readonly code: number | null
  readonly spawnError?: string
}

export type NpmRunner = (args: readonly string[], options: { cwd: string }) => Promise<NpmRunResult>

const NPM_INSTALL_ARGS = ['install', '--omit=dev', '--no-audit', '--no-fund']
// Vendored ACP agents ship without node_modules (client-platform binaries must
// not cross the wire); `npm ci` here resolves the remote host's own platform
// packages. `--omit=optional` skips the native agent binaries (claude's
// @anthropic-ai/claude-agent-sdk-* / codex's @openai/codex platform packages,
// ~500MB total) — those are downloaded on demand by the AgentBinary channel.
const VENDOR_INSTALL_ARGS = ['ci', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund']
const VENDOR_AGENT_NAMES = ['claude-agent-acp', 'codex-acp']

/** npm-cli.js location inside a Node distribution (Windows/POSIX layouts differ). */
export function resolveNpmCliPath(execPath: string, platform: NodeJS.Platform): string {
  const dir = path.dirname(execPath)
  return platform === 'win32'
    ? path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
}

/**
 * Prefer the npm-cli.js bundled with this Node distribution (shell-free), else
 * fall back to `npm` on PATH (npm.cmd on Windows needs cmd.exe — via spawnViaCmd,
 * not `shell: true`, whose unescaped args trip DEP0190). npm's stdout+stderr
 * forward to this process's stderr so stdout stays clean for protocol lines
 * while remote log collection still sees install output.
 */
export const defaultNpmRunner: NpmRunner = (args, options) =>
  new Promise((resolve) => {
    const npmCli = resolveNpmCliPath(process.execPath, process.platform)
    const stdio: StdioOptions = ['ignore', process.stderr, process.stderr]
    let child: ChildProcess
    if (existsSync(npmCli)) {
      child = spawn(process.execPath, [npmCli, ...args], {
        cwd: options.cwd,
        stdio,
        shell: false,
        windowsHide: true,
      })
    } else if (process.platform === 'win32') {
      child = spawnViaCmd('npm', args, { cwd: options.cwd, stdio })
    } else {
      child = spawn('npm', [...args], { cwd: options.cwd, stdio, shell: false })
    }
    let settled = false
    const done = (result: NpmRunResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    child.on('error', (err) => done({ code: null, spawnError: err.message }))
    child.on('close', (code) => done({ code }))
  })

async function runNpmStep(
  runner: NpmRunner,
  args: readonly string[],
  cwd: string,
  label: string,
): Promise<void> {
  const result = await runner(args, { cwd })
  if (result.code === 0 && result.spawnError === undefined) return
  const reason = result.spawnError ?? `exit ${result.code}`
  throw new Error(`npm ${label} failed in ${cwd}: ${reason}`)
}

/**
 * Install the deployed tree in `pkgDir`: npm install, then npm ci in each staged
 * vendor agent. bundle.hash is written only after every step succeeds so a
 * partial install never leaves a "complete" marker behind.
 */
export async function installBundle(
  pkgDir: string,
  bundleHash: string,
  runner: NpmRunner = defaultNpmRunner,
): Promise<void> {
  process.stderr.write(`[remote-server] install: npm install in ${pkgDir}\n`)
  await runNpmStep(runner, NPM_INSTALL_ARGS, pkgDir, 'install')
  for (const name of VENDOR_AGENT_NAMES) {
    const vendorDir = path.join(pkgDir, 'vendor', name)
    if (!existsSync(vendorDir)) continue
    process.stderr.write(`[remote-server] install: npm ci in ${vendorDir}\n`)
    await runNpmStep(runner, VENDOR_INSTALL_ARGS, vendorDir, `ci (vendor/${name})`)
  }
  await writeFile(path.join(pkgDir, BUNDLE_HASH_FILE), bundleHash)
}
