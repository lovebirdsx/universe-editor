#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Ensures every workspace artifact the editor needs at dev-run time is built before
 *  `pnpm dev` / `pnpm dev:run` launch electron-vite + the extension host. A bare
 *  `pnpm install` produces none of these `dist/`s (sources are `.ts`, emitted by
 *  `tsgo --build` / esbuild), so a fresh clone that goes straight to `pnpm dev` fails
 *  in one of two ways:
 *
 *   1. Bundled-into-main packages — listed under `main.build.externalizeDeps.exclude`
 *      in apps/editor/electron.vite.config.ts. Inlined into out/main/index.js instead
 *      of externalized, so rolldown must resolve their `dist/index.js` entry, else:
 *        "Rolldown failed to resolve import @universe-editor/<pkg> from .../main/index.ts"
 *   2. Built-in extensions with an activation entry — the extension host dynamically
 *      imports each one's `main` (dist/extension.js), so a missing build throws at
 *      activation: "Cannot find module .../extensions/<ext>/dist/extension.js".
 *
 *  Fast path (the common case): all expected artifacts present → return immediately,
 *  near zero cost (a few fs stats), mirroring vendor-install's stamp-skip philosophy.
 *  Only when something is missing do we shell out to turbo to build the editor's
 *  upstream deps (`editor^...`) plus every built-in extension (`./extensions/*`);
 *  turbo's own cache keeps that a no-op once warm. `pnpm dev`'s watcher maintains the
 *  bundled-package dist afterwards.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')

function readPkg(dir) {
  try {
    return JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

// Mirrors `main.build.externalizeDeps.exclude` in apps/editor/electron.vite.config.ts.
// Keep in sync: any package inlined into the main bundle needs its dist entry here so
// a clean checkout builds it before the first `electron-vite` run.
const BUNDLED_PACKAGES = [
  'platform',
  'extensions-common',
  'extension-api',
  'extension-gallery',
  'extension-packaging',
]

// Each expected artifact: { label, entry (abs path that must exist), buildInfo (abs
// tsconfig.tsbuildinfo to clear so a stale incremental build re-emits, or undefined) }.
const expected = []

for (const name of BUNDLED_PACKAGES) {
  const pkgDir = resolve(repoRoot, 'packages', name)
  expected.push({
    label: `@universe-editor/${name}`,
    entry: resolve(pkgDir, 'dist/index.js'),
    buildInfo: resolve(pkgDir, 'tsconfig.tsbuildinfo'),
  })
}

// Built-in extensions with an activation entry: the host imports pkg.main at runtime.
// Purely declarative extensions (themes, grammars) have no `main` and need no dist.
const extensionsDir = resolve(repoRoot, 'extensions')
for (const ext of readdirSync(extensionsDir, { withFileTypes: true })) {
  if (!ext.isDirectory()) continue
  const extDir = resolve(extensionsDir, ext.name)
  const pkg = readPkg(extDir)
  if (!pkg?.main) continue
  expected.push({
    label: pkg.name ?? ext.name,
    entry: resolve(extDir, pkg.main),
    // esbuild-built extensions have no tsbuildinfo; clearing a nonexistent file is a no-op.
    buildInfo: resolve(extDir, 'tsconfig.tsbuildinfo'),
  })
}

const missing = expected.filter((e) => !existsSync(e.entry))

if (missing.length === 0) {
  console.log('[ensure-workspace-build] all workspace artifacts present — skipping build')
  process.exit(0)
}

console.log(
  `[ensure-workspace-build] missing build output for ${missing.map((m) => m.label).join(', ')} — building upstream packages + built-in extensions (turbo)…`,
)

// A missing dist with a stale tsconfig.tsbuildinfo left behind makes `tsgo --build`
// believe the emit is up to date and skip it (turbo reports success, dist stays gone).
// Drop the buildinfo of every missing target so the rebuild actually re-emits; the
// fresh-clone case has no buildinfo and is unaffected.
for (const m of missing) {
  if (m.buildInfo) rmSync(m.buildInfo, { force: true })
}

// turbo/bin/turbo is a plain node script that re-spawns the platform-native binary.
// Invoke it via process.execPath with array args (no shell) so the `^` in the filter
// isn't mangled by cmd.exe caret escaping on Windows. --force bypasses turbo's cache
// so a cache hit can't replay past the just-cleared buildinfo and leave dist missing.
// Two filters: `editor^...` = the editor's upstream deps (covers the bundled packages);
// `./extensions/*` = every built-in extension (not part of the editor's dep graph).
const turboBin = resolve(repoRoot, 'node_modules/turbo/bin/turbo')

try {
  execFileSync(
    process.execPath,
    [
      turboBin,
      'run',
      'build',
      '--filter=@universe-editor/editor^...',
      '--filter=./extensions/*',
      '--force',
    ],
    { cwd: repoRoot, stdio: 'inherit' },
  )
} catch (err) {
  console.error('[ensure-workspace-build] workspace build failed')
  process.exit(typeof err?.status === 'number' ? err.status : 1)
}
