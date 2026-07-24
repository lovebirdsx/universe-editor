/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  run-e2e.mjs — local entry for `pnpm e2e` (repo root AND apps/editor). When the
 *  working tree's only changes are core spec files, run just those specs instead
 *  of the whole matrix; otherwise fall back to the exact original command.
 *
 *  Why this exists: editing one spec used to re-run the full core suite (~2min
 *  main pass + @serial pass) plus every extension suite. A spec file only drives
 *  its own tests, so "changed files ⊆ apps/editor/e2e/specs/*.spec.ts" is a safe
 *  exact selector — Playwright filters test files from CLI positional args.
 *
 *  Why the partial run BYPASSES turbo: the turbo `e2e` task caches on outputs.
 *  Letting a partial run inside turbo would record "success" for a file state
 *  whose other specs never ran. So the partial path spawns Playwright directly
 *  and turbo only ever caches full-suite successes. Corollary: inside a turbo
 *  task (TURBO_HASH set) this script always runs the FULL original sequence.
 *
 *  Full-mode fallback triggers (any one): CI env, TURBO_HASH env,
 *  UNIVERSE_E2E_FULL=1, git status failure, a clean tree, or any change outside
 *  apps/editor/e2e/specs/*.spec.ts (fixtures / pages / harness / src / other
 *  packages all fan out beyond a single spec file).
 *
 *  Usage:
 *    node scripts/e2e/run-e2e.mjs [--scope root|editor] [--suite e2e|e2ea] [--dry-run]
 *  (`--suite e2ea` is the regression-including variant: its main pass folds
 *  @regression back in via UNIVERSE_E2E_INCLUDE_REGRESSION=1, exactly like the
 *  original e2ea scripts — including when scoped to changed specs.)
 *--------------------------------------------------------------------------------------------*/

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const editorDir = join(repoRoot, 'apps', 'editor')
const SPEC_PREFIX = 'apps/editor/e2e/specs/'
const SPEC_SUFFIX = '.spec.ts'
const EDITOR_PREFIX = 'apps/editor/'

/** CLI args. Pure so the parsing (and its rejection of bad values) is testable. */
export function parseArgs(argv) {
  const args = { scope: 'root', suite: 'e2e', dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--scope') args.scope = argv[++i]
    else if (argv[i] === '--suite') args.suite = argv[++i]
    else if (argv[i] === '--dry-run') args.dryRun = true
  }
  if (args.scope !== 'root' && args.scope !== 'editor') {
    throw new Error(`unknown --scope: ${args.scope} (expected root|editor)`)
  }
  if (args.suite !== 'e2e' && args.suite !== 'e2ea') {
    throw new Error(`unknown --suite: ${args.suite} (expected e2e|e2ea)`)
  }
  return args
}

/**
 * Parse `git status --porcelain=v1 -z` output into every path involved. Rename /
 * copy entries are `XY new\0old\0` — the old path is included too so the scoping
 * decision stays conservative (a rename out of specs/ must force full mode).
 * Pure so the quoting/renames edge cases are unit-testable.
 */
export function parsePorcelainV1z(raw) {
  const fields = raw.split('\0')
  const paths = []
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]
    if (!entry) continue
    const xy = entry.slice(0, 2)
    paths.push(entry.slice(3))
    if (xy.includes('R') || xy.includes('C')) {
      const oldPath = fields[++i]
      if (oldPath) paths.push(oldPath)
    }
  }
  return paths
}

/**
 * Classify a changed-path set into the run plan. Pure so the routing rules are
 * unit-testable. 'specs' means every change is a core spec file (the exact-run
 * case); anything else — including an empty set (clean tree) — is 'full'.
 */
export function planChangedSpecs(changedPaths) {
  if (changedPaths.length === 0) {
    return { mode: 'full', reason: '工作区干净，无未提交改动' }
  }
  const specs = []
  for (const p of changedPaths) {
    if (p.startsWith(SPEC_PREFIX) && p.endsWith(SPEC_SUFFIX)) {
      specs.push(p)
    } else {
      return { mode: 'full', reason: `改动超出 core spec 范围: ${p}` }
    }
  }
  return { mode: 'specs', specs, reason: '改动均为 core spec 文件' }
}

/** Uncommitted changes (staged + unstaged + untracked), forward-slash paths. */
function uncommittedPaths() {
  const out = execFileSync(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
  return parsePorcelainV1z(out)
}

function run(command, args, { cwd = repoRoot, env } = {}) {
  console.log(`\n> ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: env ? { ...process.env, ...env } : process.env,
    shell: process.platform === 'win32',
  })
  if (result.error) {
    console.error(`run-e2e: failed to spawn ${command}: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function ensureEditorBuild() {
  run(process.execPath, [join(repoRoot, 'scripts/e2e/ensure-e2e-build.mjs'), '@universe-editor/editor'])
}

const PW_CONFIG = ['test', '-c', 'e2e/playwright.config.ts']

/** The two passes of the original editor `e2e`/`e2ea` script, optionally file-scoped. */
function runCoreSuite(specFilters, { regression = false } = {}) {
  run('pnpm', ['exec', 'playwright', ...PW_CONFIG, ...specFilters, '--pass-with-no-tests'], {
    cwd: editorDir,
    env: regression ? { UNIVERSE_E2E_INCLUDE_REGRESSION: '1' } : undefined,
  })
  run(
    'pnpm',
    ['exec', 'playwright', ...PW_CONFIG, ...specFilters, '--workers=1', '--pass-with-no-tests'],
    { cwd: editorDir, env: { UNIVERSE_E2E_ONLY_TAG: '@serial' } },
  )
}

/** Tags the two passes never run — tell the user where those cases went. */
function hintSkippedTags(specFiles, { regression = false } = {}) {
  const hints = [
    // e2ea folds @regression back into the main pass — nothing to hint there.
    ...(regression
      ? []
      : [[/@regression/, 'pnpm e2ea（或 pnpm --filter @universe-editor/editor e2e:regression）']]),
    [/@visual/, 'pnpm --filter @universe-editor/editor test:visual'],
    [/@flaky|@perf/, '各自的专门趟（见 apps/editor/e2e/RUNBOOK.md）'],
  ]
  const seen = new Set()
  for (const file of specFiles) {
    const content = readFileSync(join(repoRoot, file), 'utf8')
    for (const [pattern, how] of hints) {
      if (pattern.test(content) && !seen.has(String(pattern))) {
        seen.add(String(pattern))
        console.log(`run-e2e: 提示 — 选中文件含 ${String(pattern.source)} 用例，本次不会运行；请用 ${how}`)
      }
    }
  }
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`run-e2e: ${err.message}`)
    process.exit(1)
  }
  const { scope, suite, dryRun } = args
  const regression = suite === 'e2ea'

  let plan
  let forced
  if (process.env['CI']) forced = 'CI 环境'
  else if (process.env['TURBO_HASH']) forced = 'turbo 任务内（保持缓存语义=全量）'
  else if (process.env['UNIVERSE_E2E_FULL'] === '1') forced = 'UNIVERSE_E2E_FULL=1'

  if (forced) {
    plan = { mode: 'full', reason: forced }
  } else {
    try {
      plan = planChangedSpecs(uncommittedPaths())
    } catch (err) {
      plan = { mode: 'full', reason: `git status 失败: ${err.message}` }
    }
  }

  if (plan.mode === 'specs') {
    // Deleted (or renamed-away) specs have nothing to run.
    plan.specs = plan.specs.filter((p) => existsSync(join(repoRoot, p)))
    if (plan.specs.length === 0) {
      console.log('run-e2e: 改动仅为删除/移出 spec 文件，无需运行任何测试。')
      return
    }
  }

  console.log(
    `run-e2e: suite=${suite} 模式=${plan.mode === 'specs' ? '仅改动 spec' : '全量'}（${plan.reason}）`,
  )
  if (plan.mode === 'specs') {
    for (const s of plan.specs) console.log(`  - ${s}`)
    console.log('run-e2e: 需要全量时请设 UNIVERSE_E2E_FULL=1')
  }

  if (dryRun) return

  if (plan.mode === 'specs') {
    const filters = plan.specs.map((p) => p.slice(EDITOR_PREFIX.length))
    ensureEditorBuild()
    runCoreSuite(filters, { regression })
    hintSkippedTags(plan.specs, { regression })
    return
  }

  if (scope === 'editor') {
    // The original apps/editor `e2e`/`e2ea` script, verbatim (ensure build + two passes).
    ensureEditorBuild()
    runCoreSuite([], { regression })
    return
  }
  run('pnpm', [
    'exec',
    'turbo',
    'run',
    suite,
    '--filter=@universe-editor/editor',
    '--filter=./extensions/*',
    '--concurrency=1',
  ])
}

// Only run the CLI when invoked directly (not when imported by the test).
const invokedDirectly =
  process.argv[1] &&
  realpathSync(process.argv[1]).split(sep).join('/') ===
    fileURLToPath(import.meta.url).split(sep).join('/')
if (invokedDirectly) {
  main()
}
