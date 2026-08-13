/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Resolves an ACP agent entry file on the remote host. Deploy bundles stage
 *  `<out>/vendor/<name>/{dist,package.json,package-lock.json}` and the deploy
 *  script runs `npm ci --omit=dev` in each vendor dir (node_modules are never
 *  shipped over scp: they are hundreds of MB and carry client-platform native
 *  binaries). Dev/e2e direct mode falls back to the repo's own vendor tree.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

function findRepoRoot(start: string): string | undefined {
  let dir = start
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

export function resolveVendorAgentEntry(entry: 'claude' | 'codex'): string {
  const dir = entry === 'claude' ? 'claude-agent-acp' : 'codex-acp'
  const bundled = fileURLToPath(new URL(`./vendor/${dir}/dist/index.js`, import.meta.url))
  if (existsSync(bundled)) return bundled
  const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)))
  if (repoRoot) {
    const local = path.join(repoRoot, 'vendor', dir, 'dist', 'index.js')
    if (existsSync(local)) return local
  }
  return bundled
}
