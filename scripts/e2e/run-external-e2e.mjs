#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  run-external-e2e.mjs — run one out-of-workspace extension's Playwright e2e suite.
 *
 *  The `extensions-external/*` extensions ship as marketplace `.vsix` and live
 *  OUTSIDE the pnpm workspace, so — unlike the built-in `extensions/*` suites —
 *  they cannot depend on `@universe-editor/e2e-harness` / `@playwright/test` via
 *  `workspace:*` (there is no node_modules symlink to resolve those bare imports).
 *  This runner is the seam that makes their e2e work anyway:
 *
 *    1. Resolve Playwright's CLI from the REPO ROOT (createRequire), so the process
 *       loads the same single physical `@playwright/test` the harness dist resolves
 *       to — Playwright breaks if two copies load. The extension's config + fixtures
 *       import the harness via a RELATIVE path into `packages/e2e-harness/dist`.
 *    2. Strip ELECTRON_RUN_AS_NODE (Claude Code's shell injects it, degrading
 *       Electron to plain Node which rejects Chromium flags).
 *    3. Map --regression / --grep to the harness tag-filter env seams
 *       (UNIVERSE_E2E_INCLUDE_REGRESSION / UNIVERSE_E2E_NO_TAG_FILTER), so the tag
 *       policy stays the single source of truth in playwrightConfig.ts.
 *    4. Build the extension FIRST (fresh dist/), so the suite never runs a stale
 *       bundle (the "green on old output" trap). The editor build is the caller's
 *       job (root `e2e:external` / CI builds it once).
 *
 *  Usage (from an extension's package.json script, cwd = the extension dir):
 *    node ../../scripts/e2e/run-external-e2e.mjs [--regression] [--grep "<title>"]
 *--------------------------------------------------------------------------------------------*/

import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')
// The extension whose suite we run is the process cwd (its package.json script
// invokes us). Its config lives at e2e/playwright.config.ts.
const extDir = process.cwd()
const config = resolve(extDir, 'e2e/playwright.config.ts')

if (!existsSync(config)) {
  console.error(`run-external-e2e: no e2e/playwright.config.ts under ${extDir}`)
  process.exit(1)
}

// Parse the small flag surface. Everything after --grep is a single title; any
// other unrecognized arg is forwarded verbatim to `playwright test`.
const argv = process.argv.slice(2)
let regression = false
let noTagFilter = false
const passthrough = []
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--regression') {
    regression = true
  } else if (arg === '--no-tag-filter') {
    // Debug escape hatch (the `e2eg` script): let a hand-passed --grep select
    // any spec regardless of tag (see playwrightConfig grepOptions).
    noTagFilter = true
  } else if (arg === '--grep') {
    passthrough.push('--grep', argv[++i] ?? '')
  } else {
    passthrough.push(arg)
  }
}

// ELECTRON_RUN_AS_NODE=1 (Claude Code's shell) makes Electron behave as plain
// Node, which rejects the Chromium flags _electron.launch needs. Strip it here;
// the fixture's launchApp strips it again for the child, but the CLI process
// itself must also spawn a real Electron.
const { ELECTRON_RUN_AS_NODE: _ignored, ...inheritedEnv } = process.env

const require = createRequire(resolve(repoRoot, 'packages/e2e-harness/package.json'))
// Single physical @playwright/test: resolve the CLI from the harness package,
// which declares @playwright/test as a dep — the same tree the harness dist
// resolves its @playwright/test from (Playwright breaks if two copies load).
const playwrightCli = require.resolve('@playwright/test/cli')

function run(command, args, opts = {}) {
  const res = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: extDir,
    ...opts,
  })
  if (res.error) throw res.error
  return res.status ?? 1
}

// 1) Build the extension so the suite loads a fresh dist/ (avoids the stale-output
//    trap). Self-resolves esbuild via the borrow in each esbuild.config.mjs.
const buildStatus = run(process.execPath, [resolve(extDir, 'esbuild.config.mjs')], {
  env: inheritedEnv,
})
if (buildStatus !== 0) {
  console.error('run-external-e2e: extension build failed')
  process.exit(buildStatus)
}

// 2) Run Playwright with the tag-filter env seams set (never --grep-invert flags).
const status = run(process.execPath, [playwrightCli, 'test', '-c', config, ...passthrough], {
  env: {
    ...inheritedEnv,
    ...(regression ? { UNIVERSE_E2E_INCLUDE_REGRESSION: '1' } : {}),
    ...(noTagFilter ? { UNIVERSE_E2E_NO_TAG_FILTER: '1' } : {}),
  },
})
process.exit(status)
