#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  e2e.mjs — run this extension's Playwright e2e against a local universe-editor.
 *
 *  Three jobs, mirroring the official extension-samples runner:
 *
 *    1. Resolve Playwright's CLI from THIS project (createRequire) — the same
 *       physical @playwright/test the harness dist resolves to (Playwright
 *       breaks if two copies load).
 *    2. Strip ELECTRON_RUN_AS_NODE (Claude Code's shell injects it, degrading
 *       Electron to plain Node which rejects Chromium flags).
 *    3. Build the extension (node esbuild.config.mjs) so the suite never runs
 *       a stale bundle, then run the specs.
 *
 *  The editor to launch is resolved inside each worker by the harness
 *  (resolveEditorLaunchTarget reads UNIVERSE_EDITOR_BIN from env), so this
 *  runner neither parses nor intercepts that env — it is passed through verbatim.
 *--------------------------------------------------------------------------------------------*/

import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const { ELECTRON_RUN_AS_NODE: _ignored, ...inheritedEnv } = process.env

if (inheritedEnv['UNIVERSE_EDITOR_BIN']) {
  console.log(`e2e: UNIVERSE_EDITOR_BIN=${inheritedEnv['UNIVERSE_EDITOR_BIN']}`)
} else {
  console.log('e2e: UNIVERSE_EDITOR_BIN unset — harness will auto-detect (win32 installed build)')
}

// Single physical @playwright/test: resolve from THIS project, the same tree
// the harness dist resolves its @playwright/test from.
const playwrightCli = createRequire(import.meta.url).resolve('@playwright/test/cli')

function run(command, args, opts = {}) {
  const res = spawnSync(command, args, { stdio: 'inherit', ...opts })
  if (res.error) throw res.error
  return res.status ?? 1
}

const buildStatus = run(process.execPath, ['esbuild.config.mjs'], {
  env: inheritedEnv,
  cwd: projectRoot,
})
if (buildStatus !== 0) {
  console.error('e2e: build failed')
  process.exit(buildStatus)
}

const status = run(
  process.execPath,
  [playwrightCli, 'test', '-c', resolve(projectRoot, 'e2e', 'playwright.config.ts')],
  { env: { ...inheritedEnv, PLAYWRIGHT_FORCE_TTY: '0' }, cwd: projectRoot },
)
process.exit(status)
