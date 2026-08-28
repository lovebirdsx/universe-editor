/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ensure-e2e-build.mjs — freshen build artifacts before a package's e2e suite
 *  launches, so running Playwright directly inside a package (e.g. `pnpm run e2ea`
 *  from apps/editor) never tests a stale editor `out/` or extension `dist/`.
 *
 *  Usage (prepended to a package's e2e script):
 *    node ../../scripts/e2e/ensure-e2e-build.mjs <package-name> && playwright test ...
 *
 *  Behaviour:
 *    - Vendor trees are ensured first (see ensureVendorArtifacts) — they live
 *      outside the pnpm/turbo graph, so this runs even when TURBO_HASH is set.
 *    - If TURBO_HASH is set we are already inside a turbo task (the root
 *      `pnpm e2e` / `e2e:ext` path). Turbo's dependency graph already built
 *      everything upstream; skip to avoid spawning a nested turbo run.
 *    - Otherwise delegate to turbo (via `pnpm exec`, so it resolves regardless of
 *      PATH): build the editor and the calling package together with their full
 *      upstreams. Cache hits make this near-instant when artifacts are fresh;
 *      only stale packages actually rebuild.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runLinuxPreflight } from './linux-preflight.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Gitignored npm tree holding the tsserver CLI spawned by the typescript extension. */
const TS_LS_VENDOR = 'vendor/typescript-language-server'

/**
 * The vendored typescript-language-server is a gitignored npm tree outside the
 * pnpm workspace (installed via npm, see scripts/release/vendor-install.mjs).
 * A fresh clone/worktree lacks it and e2e fails late with e.g. "typescript
 * language server is not running". Install it when missing; presence is the
 * skip-stamp, so re-runs cost one fs stat. The agent forks need neither
 * submodule nor dist for e2e (ACP specs use the echo-agent fixture), so they
 * are intentionally out of scope here.
 */
function ensureVendorArtifacts() {
  const cli = join(
    repoRoot,
    TS_LS_VENDOR,
    'node_modules/typescript-language-server/lib/cli.mjs',
  )
  if (existsSync(cli)) return
  console.log(`[ensure-e2e-build] installing ${TS_LS_VENDOR} (npm ci)…`)
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(npm, ['ci'], {
    cwd: join(repoRoot, TS_LS_VENDOR),
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const selfPackage = process.argv[2]
if (!selfPackage) {
  console.error('ensure-e2e-build: missing <package-name> argument')
  process.exit(1)
}

ensureVendorArtifacts()

// Already inside a turbo task — turbo built the dependency graph for us.
if (process.env['TURBO_HASH']) process.exit(0)

// Preflight before a (possibly full) build — fail fast on a broken Linux env.
try {
  await runLinuxPreflight()
} catch (err) {
  console.error(err.message)
  process.exit(1)
}

const result = spawnSync(
  'pnpm',
  [
    'exec',
    'turbo',
    'run',
    'build',
    '--filter=@universe-editor/editor...',
    `--filter=${selfPackage}...`,
    // remote-server's dist/bootstrap.js is spawned by the remote specs via
    // UNIVERSE_REMOTE_SERVER_CMD; it is not a dependency of the editor, so pull
    // its build in explicitly (the root turbo `e2e` task already does the same).
    '--filter=@universe-editor/remote-server...',
  ],
  { stdio: 'inherit', shell: process.platform === 'win32' },
)

if (result.error) {
  console.error('ensure-e2e-build: failed to run turbo:', result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
