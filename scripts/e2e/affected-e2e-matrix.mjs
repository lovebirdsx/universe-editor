/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  affected-e2e-matrix.mjs — emit the GitHub Actions job matrices for E2E, scoped
 *  to what a change actually touched (P4 affected execution).
 *
 *  Two outputs (written as GITHUB_OUTPUT lines, or printed when run locally):
 *    - core:       "true"/"false" — whether the core suite (apps/editor + its
 *                  transitive deps: platform / workbench-ui / harness / contract /
 *                  the git·typescript·markdown extensions its scoped fixtures use)
 *                  is affected and must run.
 *    - extensions: JSON array of {name, dir, prep} for each extension whose own
 *                  `e2e` task turbo marks affected. `prep` names the extra CI
 *                  setup that extension's specs need (tsserver / excel-diff vsix).
 *
 *  How "affected" is computed: `turbo run e2e --filter=...[<base>] --dry=json`.
 *  Turbo walks the workspace dependency graph, so editing `platform` marks every
 *  downstream e2e affected (correct — a kernel change should be fully tested),
 *  while editing one extension marks only that extension (+ core if a core scoped
 *  fixture depends on it).
 *
 *  On the main branch (or when no base ref resolves) we force EVERYTHING on — the
 *  merge-queue / nightly full run is the safety net for the affected heuristic.
 *
 *  Usage:
 *    node scripts/e2e/affected-e2e-matrix.mjs [--base <ref>] [--all]
 *    (CI passes --base origin/main on PRs, --all on main pushes)
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// The core suite lives in apps/editor, but its scoped fixtures activate a few
// extensions at runtime (peekPreview→typescript, outline→typescript, dirtyDiff /
// vscodeKeybindings→git, peekNavigation→markdown). apps/editor has NO package.json
// dep on those extensions, so turbo won't mark core affected when they change.
// List them here so a change to one still reruns the core suite that exercises it.
const CORE_EXTRA_PACKAGES = [
  '@universe-editor/editor',
  '@universe-editor/platform',
  '@universe-editor/workbench-ui',
  '@universe-editor/e2e-harness',
  '@universe-editor/e2e-contract',
  '@universe-editor/git',
  '@universe-editor/typescript',
  '@universe-editor/markdown',
]

// Extensions that own an `e2e` suite, with the extra CI prep their specs need.
// `prep` maps to conditional steps in ci.yml.
const EXTENSION_SUITES = [
  { name: '@universe-editor/markdown', dir: 'extensions/markdown', prep: 'none' },
  { name: '@universe-editor/typescript', dir: 'extensions/typescript', prep: 'tsserver' },
  { name: '@universe-editor/ai', dir: 'extensions/ai', prep: 'none' },
  { name: '@universe-editor/perforce', dir: 'extensions/perforce', prep: 'excel-diff' },
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
  const plan = JSON.parse(out)
  const pkgs = new Set()
  for (const task of plan.tasks ?? []) {
    if (task.command && task.command !== '<NONEXISTENT>' && /playwright/.test(task.command)) {
      pkgs.add(task.package)
    }
  }
  return pkgs
}

function main() {
  const { all, base } = parseArgs(process.argv.slice(2))

  let core
  let extensions
  if (all || !base) {
    core = true
    extensions = EXTENSION_SUITES
  } else {
    const affected = affectedE2ePackages(base)
    core = CORE_EXTRA_PACKAGES.some((p) => affected.has(p))
    extensions = EXTENSION_SUITES.filter((s) => affected.has(s.name))
  }

  const outputs = {
    core: String(core),
    extensions: JSON.stringify(extensions),
    'has-extensions': String(extensions.length > 0),
  }

  const gh = process.env.GITHUB_OUTPUT
  if (gh) {
    for (const [k, v] of Object.entries(outputs)) appendFileSync(gh, `${k}=${v}\n`)
  }
  for (const [k, v] of Object.entries(outputs)) console.log(`${k}=${v}`)
}

main()
