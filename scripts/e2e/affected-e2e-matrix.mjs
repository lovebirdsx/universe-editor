/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  affected-e2e-matrix.mjs — emit the GitHub Actions job matrices for E2E, scoped
 *  to what a change actually touched (P4 affected execution).
 *
 *  Two outputs (written as GITHUB_OUTPUT lines, or printed when run locally):
 *    - core:       "true"/"false" — whether the core suite (apps/editor) is
 *                  affected and must run.
 *    - extensions: JSON array of {name, dir, prep} for each extension whose own
 *                  `e2e` task turbo marks affected. `prep` names the extra CI
 *                  setup that extension's specs need (tsserver).
 *    - package-windows: "true"/"false" — whether the expensive Windows packaging
 *                  job should run (packaging-mechanism paths, or forced on --all).
 *    - acp-contract: "true"/"false" — whether the cross-repo ACP contract test
 *                  (spawns real fork dist) should run (editor↔fork wire paths, or
 *                  forced on --all).
 *
 *  How "affected" is computed: `turbo run e2e --filter=...[<base>] --dry=json`.
 *  Turbo walks the workspace dependency graph, so editing `platform` marks every
 *  downstream e2e affected (correct — a kernel change should be fully tested),
 *  while editing one extension marks only that extension (+ core if a core scoped
 *  fixture depends on it).
 *
 *  Why core = "is @universe-editor/editor affected?" and NOT a hand-maintained
 *  package list: the core suite's scoped fixtures (peekPreview→typescript,
 *  outline→typescript, dirtyDiff/vscodeKeybindings→git, peekNavigation→markdown)
 *  activate those extensions at RUNTIME. That dependency used to be invisible to
 *  turbo (apps/editor had no package.json dep on them), so a change to one wouldn't
 *  re-run the core spec exercising it — hence a hand-kept CORE_EXTRA_PACKAGES list
 *  that silently drifted. Those extensions are now real `devDependencies` of
 *  apps/editor, so turbo's `...[base]` fans a change to git/typescript/markdown up
 *  to the editor's e2e task automatically. Core is affected iff editor is.
 *
 *  On the main branch (or when no base ref resolves) we force EVERYTHING on — the
 *  merge-queue / nightly full run is the safety net for the affected heuristic.
 *
 *  Usage:
 *    node scripts/e2e/affected-e2e-matrix.mjs [--base <ref>] [--all]
 *    (CI passes --base origin/main on PRs, --all on main pushes)
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process'
import { appendFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sep } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// The core E2E suite package. Its transitive deps (platform / workbench-ui /
// e2e-harness / e2e-contract) AND the extensions its scoped fixtures activate at
// runtime (git / typescript / markdown) are all declared as devDependencies of
// apps/editor, so turbo fans any of their changes up to this package's e2e task.
export const CORE_PACKAGE = '@universe-editor/editor'

// Extensions that own an `e2e` suite, with the extra CI prep their specs need.
// `prep` maps to conditional steps in ci.yml.
export const EXTENSION_SUITES = [
  { name: '@universe-editor/markdown', dir: 'extensions/markdown', prep: 'none' },
  { name: '@universe-editor/typescript', dir: 'extensions/typescript', prep: 'tsserver' },
  { name: '@universe-editor/ai', dir: 'extensions/ai', prep: 'none' },
  { name: '@universe-editor/perforce', dir: 'extensions/perforce', prep: 'none' },
]

// Out-of-workspace marketplace extensions with their own e2e suite. They are NOT
// in turbo's graph, so their affectedness is computed by git path diff (below),
// not turbo `...[base]`. `prep` names the extra CI setup the suite needs:
//   - 'xlsx':  the Excel extension bundles SheetJS (npm ci in its dir first)
//   - 'none':  self-contained (pdf), or borrows a workspace dep at build (eslint)
export const EXTERNAL_SUITES = [
  { name: 'eslint', dir: 'extensions-external/eslint', prep: 'none' },
  { name: 'pdf', dir: 'extensions-external/pdf', prep: 'none' },
  { name: 'excel-diff', dir: 'extensions-external/excel-diff', prep: 'xlsx' },
]

// A change to any of these shared inputs fans out to EVERY external suite: they
// run the editor's packaged build and import the harness at runtime, so a change
// to either can break all of them. (Turbo captures this for in-workspace suites;
// external ones need it spelled out.)
const EXTERNAL_SHARED_PATHS = [
  'apps/editor/',
  'packages/e2e-harness/',
  'packages/e2e-contract/',
  'packages/extension-host/',
  'packages/extension-api/',
  'scripts/e2e/',
]

// The Windows packaging job is expensive (full electron-builder run) and used to
// fire on every PR. It validates the PACKAGING MECHANISM (electron-builder config,
// NSIS installer, vendor extraResources, runtime staging) rather than business
// logic — those are covered by e2e. So on a PR it runs only when a change could
// affect the packaged artifact's mechanism; everything else (main push / tag /
// manual dispatch) forces it on via `--all`. Business-only renderer/main edits no
// longer trigger it — the main-push full run is the safety net.
const PACKAGE_PATHS = [
  'apps/editor/electron-builder.yml',
  'apps/editor/build/', // NSIS installer.nsh, icons, entitlements
  'apps/editor/package.json', // packaging scripts / electron dep bumps
  'apps/editor/electron.vite.config.ts',
  'scripts/release/', // runtime-resources staging, vendor-install
  'vendor/', // agent forks bundled into resources/
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
]

// The cross-repo ACP contract test spawns the REAL fork dist, so it needs a
// submodule checkout + `pnpm agent:build` — too expensive to run every PR. It runs
// only when a change could shift the editor↔fork wire contract: the forks
// themselves, the editor's ACP renderer services, or the main-side agent host /
// binary / config services. main push forces it on via `--all` (full safety net).
const ACP_CONTRACT_PATHS = [
  'vendor/',
  'apps/editor/src/renderer/services/acp/',
  'apps/editor/src/main/services/acpHost/',
  'apps/editor/src/main/services/claudeBinary/',
  'apps/editor/src/main/services/claudeConfig/',
  'apps/editor/src/main/services/codexBinary/',
  'apps/editor/src/main/services/codexConfig/',
  'apps/editor/integration/fixtures/realForkConnection.ts',
  'apps/editor/integration/scenarios/acpForkContract.integration.test.ts',
]

function parseArgs(argv) {
  const args = { all: false, base: undefined }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--all') args.all = true
    else if (argv[i] === '--base') args.base = argv[++i]
  }
  return args
}

/**
 * Parse a turbo `--dry=json` plan into the set of package names with a real
 * (non-<NONEXISTENT>) playwright `e2e` command. Pure so it can be unit-tested
 * against captured/synthetic plans without spawning turbo.
 */
export function e2ePackagesFromPlan(plan) {
  const pkgs = new Set()
  for (const task of plan.tasks ?? []) {
    if (task.command && task.command !== '<NONEXISTENT>' && /playwright/.test(task.command)) {
      pkgs.add(task.package)
    }
  }
  return pkgs
}

/**
 * Turn the affected-package set into the CI outputs. Pure (no turbo, no env) so
 * the routing rules are directly unit-tested. `all` forces the full matrix (main
 * / nightly safety net); otherwise core runs iff the editor package is affected,
 * and each extension suite runs iff its own package is affected.
 */
export function computeMatrix(affected, { all = false } = {}) {
  if (all) {
    return { core: true, extensions: EXTENSION_SUITES }
  }
  return {
    core: affected.has(CORE_PACKAGE),
    extensions: EXTENSION_SUITES.filter((s) => affected.has(s.name)),
  }
}

/**
 * Which external suites are affected by a set of changed file paths. Pure so the
 * routing is unit-testable. A suite runs iff a shared input changed (fans out to
 * all) OR a path under its own dir changed. `all` forces the full set.
 */
export function computeExternalMatrix(changedPaths, { all = false } = {}) {
  if (all) return EXTERNAL_SUITES
  const paths = [...changedPaths]
  const sharedTouched = paths.some((p) => EXTERNAL_SHARED_PATHS.some((s) => p.startsWith(s)))
  if (sharedTouched) return EXTERNAL_SUITES
  return EXTERNAL_SUITES.filter((s) => paths.some((p) => p.startsWith(`${s.dir}/`)))
}

/**
 * Whether the Windows packaging job should run for a set of changed file paths.
 * Pure so the routing is unit-testable. `all` forces it on (main push / tag /
 * manual dispatch); otherwise it runs iff a change touches the packaging
 * mechanism (see {@link PACKAGE_PATHS}).
 */
export function computeShouldPackage(changedPaths, { all = false } = {}) {
  if (all) return true
  return [...changedPaths].some((p) => PACKAGE_PATHS.some((prefix) => p.startsWith(prefix)))
}

/**
 * Whether the cross-repo ACP contract test should run for a set of changed file
 * paths. Pure so the routing is unit-testable. `all` forces it on (main push);
 * otherwise it runs iff a change touches the editor↔fork wire surface (see
 * {@link ACP_CONTRACT_PATHS}).
 */
export function computeShouldRunAcpContract(changedPaths, { all = false } = {}) {
  if (all) return true
  return [...changedPaths].some((p) => ACP_CONTRACT_PATHS.some((prefix) => p.startsWith(prefix)))
}

/**
 * Ask turbo which packages have an affected `e2e` task. Returns the set of
 * package names with a real (non-<NONEXISTENT>) e2e command. Filter is
 * `...[<base>]` — the `...` includes dependents so a dep change fans out.
 */
function affectedE2ePackages(base) {
  // Invoke turbo's JS entry via `node` (no shell) so this works identically on
  // Windows and Linux CI — `npx` is not directly spawnable without a shell.
  const turboBin = require.resolve('turbo/bin/turbo')
  const out = execFileSync(
    process.execPath,
    [turboBin, 'run', 'e2e', `--filter=...[${base}]`, '--dry=json'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
  return e2ePackagesFromPlan(JSON.parse(out))
}

/** Files changed since `base` (git name-only diff), as forward-slash paths. */
function changedPathsSince(base) {
  const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
}

function main() {
  const { all, base } = parseArgs(process.argv.slice(2))
  const forceAll = all || !base
  const affected = forceAll ? new Set() : affectedE2ePackages(base)
  const { core, extensions } = computeMatrix(affected, { all: forceAll })
  const changedPaths = forceAll ? [] : changedPathsSince(base)
  const external = computeExternalMatrix(changedPaths, { all: forceAll })
  const shouldPackage = computeShouldPackage(changedPaths, { all: forceAll })
  const shouldRunAcpContract = computeShouldRunAcpContract(changedPaths, { all: forceAll })

  const outputs = {
    core: String(core),
    extensions: JSON.stringify(extensions),
    'has-extensions': String(extensions.length > 0),
    external: JSON.stringify(external),
    'has-external': String(external.length > 0),
    'package-windows': String(shouldPackage),
    'acp-contract': String(shouldRunAcpContract),
  }

  const gh = process.env.GITHUB_OUTPUT
  if (gh) {
    for (const [k, v] of Object.entries(outputs)) appendFileSync(gh, `${k}=${v}\n`)
  }
  for (const [k, v] of Object.entries(outputs)) console.log(`${k}=${v}`)
}

// Only run the CLI when invoked directly (not when imported by the test).
const invokedDirectly =
  process.argv[1] &&
  realpathSync(process.argv[1]).split(sep).join('/') ===
    fileURLToPath(import.meta.url).split(sep).join('/')
if (invokedDirectly) {
  main()
}
