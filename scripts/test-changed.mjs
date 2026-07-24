/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  test-changed.mjs — 按 git 变更选择性运行 vitest：变更若全部是测试文件
 *  (*.test.ts/x)，只跑这些文件；一旦混入源码 / 配置等非测试文件，回退全量。
 *
 *  用法:
 *    pnpm test:changed              # 未提交变更（staged + unstaged + untracked）
 *    pnpm test:changed --base main  # 工作区相对 merge-base(main, HEAD) 的全部差异
 *    node scripts/test-changed.mjs --check
 *                                   # pnpm check 的 test 环节：纯测试变更 → lint/typecheck
 *                                   # + targeted vitest（先 turbo build 保证上游 dist 新鲜）；
 *                                   # 否则原样委托 turbo run lint typecheck test
 *
 *  --check 的安全性：纯测试变更是 import 图的叶子，改 A 测试不影响 B 测试；判定集合
 *  与各包 vitest include 精确对齐（editor unit = src/{main,shared,renderer}，
 *  integration = integration/scenarios，其余包 = src/）。任何非测试文件（含
 *  __tests__ helper、vitest config、package.json、tsconfig、lockfile）都判不纯。
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const TEST_FILE_RE = /\.test\.tsx?$/
// editor unit 三 project 的 include 根（src/preload、src/test-fixtures 不被 vitest 收集）
const EDITOR_UNIT_ROOTS = ['src/main/', 'src/shared/', 'src/renderer/']
// 依赖面变化可能影响所有包的测试
const GLOBAL_FULL_RUN_FILES = new Set(['pnpm-lock.yaml', 'pnpm-workspace.yaml'])

function git(args) {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) {
    console.error(`test-changed: git ${args.join(' ')} failed:\n${r.stderr}`)
    process.exit(1)
  }
  return r.stdout
}

function pnpm(args) {
  const r = spawnSync('pnpm', args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (r.error || r.status !== 0) process.exit(r.status ?? 1)
}

// porcelain v1 -z: "XY <path>\0"，rename/copy 为 "XY <new>\0<old>\0"
function parsePorcelain(out) {
  const entries = out.split('\0')
  const files = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry) continue
    const [x, y] = entry
    if (x === 'R' || x === 'C') i++
    files.push({ path: entry.slice(3), deleted: x === 'D' || y === 'D' })
  }
  return files
}

function collectChangedFiles(baseRef) {
  if (!baseRef) return parsePorcelain(git(['status', '--porcelain=v1', '-z']))
  const mergeBase = git(['merge-base', baseRef, 'HEAD']).trim()
  const committed = git(['diff', '--name-only', '-z', '--diff-filter=d', mergeBase])
    .split('\0')
    .filter(Boolean)
    .map((p) => ({ path: p, deleted: false }))
  // diff 不含 untracked，从 porcelain 补
  const seen = new Set(committed.map((f) => f.path))
  const untracked = parsePorcelain(git(['status', '--porcelain=v1', '-z'])).filter(
    (f) => !seen.has(f.path),
  )
  return [...committed, ...untracked]
}

// --check 基线：在任务分支上取 main 的 merge-base（覆盖已提交的分支工作），否则未提交变更
function resolveCheckBase() {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  if (branch === 'main') return undefined
  const r = spawnSync('git', ['rev-parse', '--verify', 'main'], { cwd: repoRoot, stdio: 'pipe' })
  return r.status === 0 ? 'main' : undefined
}

function discoverPackages() {
  const pkgs = []
  for (const group of ['apps', 'packages', 'extensions']) {
    const dir = path.join(repoRoot, group)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      const pkgJsonPath = path.join(dir, name, 'package.json')
      if (!existsSync(pkgJsonPath)) continue
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
      if (!pkgJson.scripts?.test) continue
      pkgs.push({ name: pkgJson.name, root: `${group}/${name}` })
    }
  }
  return pkgs
}

const isPkgLevel = (rel) => rel === 'package.json' || rel.startsWith('tsconfig')

function domainsFor(pkgName) {
  if (pkgName === '@universe-editor/editor') {
    return [
      {
        label: 'unit',
        isTest: (rel) => EDITOR_UNIT_ROOTS.some((p) => rel.startsWith(p)) && TEST_FILE_RE.test(rel),
        affects: (rel) =>
          isPkgLevel(rel) ||
          rel.startsWith('src/') ||
          rel.startsWith('test-stubs/') ||
          rel.startsWith('vitest'),
        run: (files) => ['exec', 'vitest', 'run', ...files],
      },
      {
        label: 'integration',
        isTest: (rel) => rel.startsWith('integration/scenarios/') && TEST_FILE_RE.test(rel),
        affects: (rel) => isPkgLevel(rel) || rel.startsWith('integration/'),
        // 该 config 的 root 是 integration/，过滤路径须相对它
        run: (files) => [
          'exec',
          'vitest',
          'run',
          '--config',
          'integration/vitest.config.ts',
          ...files.map((f) => f.slice('integration/'.length)),
        ],
      },
    ]
  }
  return [
    {
      label: 'test',
      isTest: (rel) => rel.startsWith('src/') && TEST_FILE_RE.test(rel),
      affects: (rel) => isPkgLevel(rel) || rel.startsWith('src/') || rel.startsWith('vitest'),
      run: (files) => ['exec', 'vitest', 'run', '--passWithNoTests', ...files],
    },
  ]
}

function buildPlans(changed, pkgs) {
  const runAll = changed.some((f) => GLOBAL_FULL_RUN_FILES.has(f.path))
  const outside = []
  const plans = []
  for (const pkg of pkgs) {
    const prefix = `${pkg.root}/`
    const pkgFiles = changed.filter((f) => f.path.startsWith(prefix))
    if (pkgFiles.length === 0 && !runAll) continue
    const domains = domainsFor(pkg.name).map((d) => ({ ...d, full: runAll, targeted: [] }))
    for (const f of pkgFiles) {
      const rel = f.path.slice(prefix.length)
      const testDomain = domains.find((d) => d.isTest(rel))
      if (testDomain) {
        if (!f.deleted && existsSync(path.join(repoRoot, f.path))) testDomain.targeted.push(rel)
        continue
      }
      const affected = domains.find((d) => d.affects(rel))
      if (affected) affected.full = true
      else outside.push(f.path)
    }
    const active = domains.filter((d) => d.full || d.targeted.length > 0)
    if (active.length > 0) plans.push({ pkg, domains: active })
  }
  outside.push(
    ...changed
      .filter(
        (f) =>
          !GLOBAL_FULL_RUN_FILES.has(f.path) && !pkgs.some((p) => f.path.startsWith(`${p.root}/`)),
      )
      .map((f) => f.path),
  )
  return { plans, outside, runAll }
}

// 纯度判定：每个变更文件要么是某域的测试文件，要么是测试域外（docs/e2e/bench，check
// 本就不跑）；命中 affects 或全局文件即不纯。无变更也不算纯（交 turbo 缓存语义）。
function isPureTestChange(changed, pkgs) {
  if (changed.length === 0) return false
  for (const f of changed) {
    if (GLOBAL_FULL_RUN_FILES.has(f.path)) return false
    const pkg = pkgs.find((p) => f.path.startsWith(`${p.root}/`))
    if (!pkg) continue
    const rel = f.path.slice(pkg.root.length + 1)
    const domains = domainsFor(pkg.name)
    if (domains.some((d) => d.isTest(rel))) continue
    if (domains.some((d) => d.affects(rel))) return false
  }
  return true
}

function runPlans(plans) {
  const failed = []
  for (const plan of plans) {
    for (const d of plan.domains) {
      console.log(
        `\n▶ ${plan.pkg.name} [${d.label}] — ${d.full ? 'full suite' : `${d.targeted.length} changed file(s)`}`,
      )
      const r = spawnSync('pnpm', ['--filter', plan.pkg.name, ...d.run(d.full ? [] : d.targeted)], {
        cwd: repoRoot,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      })
      if (r.status !== 0) failed.push(`${plan.pkg.name} [${d.label}]`)
    }
  }
  return failed
}

function printOutside(outside) {
  if (outside.length === 0) return
  console.log(`\nℹ ${outside.length} changed file(s) outside vitest scope (skipped):`)
  for (const p of outside.slice(0, 10)) console.log(`  - ${p}`)
  if (outside.length > 10) console.log(`  ... and ${outside.length - 10} more`)
}

function checkMain() {
  const baseRef = resolveCheckBase()
  const changed = collectChangedFiles(baseRef)
  const pkgs = discoverPackages()

  if (!isPureTestChange(changed, pkgs)) {
    console.log('test-changed: non-test-only or no changes, delegating to turbo full run')
    pnpm(['exec', 'turbo', 'run', 'lint', 'typecheck', 'test'])
    return
  }

  console.log(`test-changed: test-only changes${baseRef ? ` (base: ${baseRef})` : ''}`)
  pnpm(['exec', 'turbo', 'run', 'lint', 'typecheck'])

  const { plans, outside } = buildPlans(changed, pkgs)
  if (plans.length > 0) {
    // targeted 绕过 turbo test，丢失 dependsOn ^build 的 dist 新鲜度保证，先补 build
    //（build inputs 不含测试文件，此处必然缓存命中）
    pnpm(['exec', 'turbo', 'run', 'build', ...plans.map((p) => `--filter=${p.pkg.name}...`)])
    const failed = runPlans(plans)
    if (failed.length > 0) {
      console.error(`\ntest-changed: FAILED — ${failed.join(', ')}`)
      process.exit(1)
    }
  } else {
    console.log('test-changed: no test files changed, skipping vitest')
  }
  printOutside(outside)
  console.log('\ntest-changed: all passed')
}

function main() {
  const argv = process.argv.slice(2)
  let baseRef
  let checkMode = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') {
      baseRef = argv[++i]
      if (!baseRef) {
        console.error('test-changed: --base requires a ref')
        process.exit(1)
      }
    } else if (argv[i] === '--check') {
      checkMode = true
    } else {
      console.error(`test-changed: unknown argument: ${argv[i]}`)
      process.exit(1)
    }
  }
  if (checkMode && baseRef) {
    console.error('test-changed: --check picks its own base, do not combine with --base')
    process.exit(1)
  }
  if (checkMode) {
    checkMain()
    return
  }

  const changed = collectChangedFiles(baseRef)
  if (changed.length === 0) {
    console.log('test-changed: no changes detected, nothing to run')
    return
  }

  const pkgs = discoverPackages()
  const { plans, outside, runAll } = buildPlans(changed, pkgs)
  if (runAll) {
    console.log('test-changed: lockfile/workspace changed, running full test suites')
  }
  if (plans.length === 0) {
    console.log('test-changed: no test-affecting changes, nothing to run')
    printOutside(outside)
    return
  }

  const failed = runPlans(plans)
  printOutside(outside)
  if (failed.length > 0) {
    console.error(`\ntest-changed: FAILED — ${failed.join(', ')}`)
    process.exit(1)
  }
  console.log('\ntest-changed: all passed')
}

main()
