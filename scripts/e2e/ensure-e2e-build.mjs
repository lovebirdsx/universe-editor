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
 *    - If TURBO_HASH is set we are already inside a turbo task (the root
 *      `pnpm e2e` / `e2e:ext` path). Turbo's dependency graph already built
 *      everything upstream; skip to avoid spawning a nested turbo run.
 *    - Otherwise delegate to turbo (via `pnpm exec`, so it resolves regardless of
 *      PATH): build the editor and the calling package together with their full
 *      upstreams. Cache hits make this near-instant when artifacts are fresh;
 *      only stale packages actually rebuild.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import { runLinuxPreflight } from './linux-preflight.mjs'

const selfPackage = process.argv[2]
if (!selfPackage) {
  console.error('ensure-e2e-build: missing <package-name> argument')
  process.exit(1)
}

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
