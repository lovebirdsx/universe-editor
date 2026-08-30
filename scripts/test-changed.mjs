/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  test-changed.mjs — 按 git 变更选择性运行 vitest。
 *
 *  用法:
 *    pnpm test:changed              # 未提交变更（staged + unstaged + untracked）
 *    pnpm test:changed --base main  # 工作区相对 merge-base(main, HEAD) 的全部差异
 *    node scripts/test-changed.mjs --check
 *                                   # pnpm check 的 test 环节，按变更分类选执行策略：
 *                                   #   纯测试文件     → 只跑变更的测试文件（targeted）
 *                                   #   叶子包源码     → vitest related 按 import 图选受影响测试
 *                                   #   配置类/非叶子包 → 原样委托 turbo run lint typecheck test
 *
 *  --check 的安全边界（完备性由 CI 全量兜底，本地是快信号不是放水门禁）：
 *    - targeted：测试文件是 import 图的叶子，改 A 测试不影响 B 测试，精确安全。
 *    - related：vitest 静态 import 图能追到「谁引用了变更源码」，但三类依赖不在图内，
 *      对应三条退全量规则：
 *        1. config alias 注入（editor 的 test-stubs 经 resolve.alias 替换 monaco）
 *           → test-stubs/ 判 full；
 *        2. 跨包 dist 边界（下游包 import 的是上游 dist/，图断在包界）
 *           → 仅无 workspace dependent 的叶子包可 related，非叶子包源码变更退 full；
 *        3. 配置本身改变收集/解析规则 → package.json、tsconfig*、vitest 配置、
 *           lockfile、turbo.json 变更退 full。删除源码文件同样退 full（已删文件无法建图，
 *           而引用它的测试正是最该跑的）。
 *    - 判定集合与各包 vitest include 精确对齐（editor unit = src/{main,shared,renderer}，
 *      integration = integration/scenarios，其余包 = src/）。
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const TEST_FILE_RE = /\.test\.tsx?$/
// editor unit 三 project 的 include 根（src/preload、src/test-fixtures 不被 vitest 收集）
const EDITOR_UNIT_ROOTS = ['src/main/', 'src/shared/', 'src/renderer/']
// 依赖面变化可能影响所有包的测试
const GLOBAL_FULL_RUN_FILES = new Set(['pnpm-lock.yaml', 'pnpm-workspace.yaml'])
// 额外只让 --check 退全量：turbo.json 改变任务图/缓存语义，但不改变 vitest 结果本身
const CHECK_FULL_RUN_FILES = new Set([...GLOBAL_FULL_RUN_FILES, 'turbo.json'])

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

/** 全部 workspace 包（含无 test script 的，供叶子判定），deps 只收 workspace: 依赖。 */
function discoverPackages() {
  const pkgs = []
  for (const group of ['apps', 'packages', 'extensions']) {
    const dir = path.join(repoRoot, group)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      const pkgJsonPath = path.join(dir, name, 'package.json')
      if (!existsSync(pkgJsonPath)) continue
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
      const deps = Object.entries({
        ...pkgJson.dependencies,
        ...pkgJson.devDependencies,
      })
        .filter(([, v]) => typeof v === 'string' && v.startsWith('workspace:'))
        .map(([k]) => k)
      pkgs.push({
        name: pkgJson.name,
        root: `${group}/${name}`,
        deps,
        hasTest: Boolean(pkgJson.scripts?.test),
      })
    }
  }
  return pkgs
}

/**
 * 叶子 = 不被任何 workspace 包依赖。链 A→B→C 中 B、C 都被各自直接上游标记，
 * 直接依赖并集即可覆盖传递链，无需闭包。
 */
export function buildLeafSet(pkgs) {
  const depended = new Set(pkgs.flatMap((p) => p.deps))
  return new Set(pkgs.filter((p) => !depended.has(p.name)).map((p) => p.name))
}

const isPkgLevel = (rel) => rel === 'package.json' || rel.startsWith('tsconfig')

/**
 * 每个测试域四组谓词：isTest（targeted 精确安全）/ isFull（--check 必须退全量）/
 * isRelated（--check 可用 import 图追踪）/ affects（test:changed 模式的整域触发；
 * integration 域也含 src——scenarios 直接 import '../../src/**'，给服务加一个必填
 * 注入却漏改 integration 侧构造点这类问题，要在最快的本地命令里就暴露）。
 * 一个文件可命中多个域的 affects（src 同时触发 unit 与 integration）。
 */
function domainsFor(pkgName) {
  if (pkgName === '@universe-editor/editor') {
    return [
      {
        label: 'unit',
        isTest: (rel) => EDITOR_UNIT_ROOTS.some((p) => rel.startsWith(p)) && TEST_FILE_RE.test(rel),
        isFull: (rel) => isPkgLevel(rel) || rel.startsWith('test-stubs/') || rel.startsWith('vitest'),
        isRelated: (rel) => rel.startsWith('src/'),
        affects: (rel) =>
          isPkgLevel(rel) ||
          rel.startsWith('src/') ||
          rel.startsWith('test-stubs/') ||
          rel.startsWith('vitest'),
        run: (files) => ['exec', 'vitest', 'run', ...files],
        relatedRun: (files) => ['exec', 'vitest', 'related', '--run', '--passWithNoTests', ...files],
      },
      {
        label: 'integration',
        isTest: (rel) => rel.startsWith('integration/scenarios/') && TEST_FILE_RE.test(rel),
        isFull: (rel) =>
          isPkgLevel(rel) ||
          rel === 'integration/vitest.config.ts' ||
          rel === 'integration/tsconfig.json',
        // scenarios/fixtures 直接 import '../../src/**'，src 变更对本域同样要追
        isRelated: (rel) => rel.startsWith('integration/') || rel.startsWith('src/'),
        affects: (rel) =>
          isPkgLevel(rel) || rel.startsWith('integration/') || rel.startsWith('src/'),
        // 该 config 的 root 是 integration/，targeted 过滤路径须相对它
        run: (files) => [
          'exec',
          'vitest',
          'run',
          '--config',
          'integration/vitest.config.ts',
          ...files.map((f) => f.slice('integration/'.length)),
        ],
        // related 的文件参数可能在 root 之外（src/**），统一传绝对路径
        relatedRun: (files) => [
          'exec',
          'vitest',
          'related',
          '--run',
          '--passWithNoTests',
          '--config',
          'integration/vitest.config.ts',
          ...files,
        ],
      },
    ]
  }
  return [
    {
      label: 'test',
      isTest: (rel) => rel.startsWith('src/') && TEST_FILE_RE.test(rel),
      isFull: (rel) => isPkgLevel(rel) || rel.startsWith('vitest'),
      isRelated: (rel) => rel.startsWith('src/'),
      affects: (rel) => isPkgLevel(rel) || rel.startsWith('src/') || rel.startsWith('vitest'),
      run: (files) => ['exec', 'vitest', 'run', '--passWithNoTests', ...files],
      relatedRun: (files) => ['exec', 'vitest', 'related', '--run', '--passWithNoTests', ...files],
    },
  ]
}

/** fileExists 可注入以便单测（默认查磁盘），与 classifyCheck 一致。 */
export function buildPlans(changed, pkgs, fileExists) {
  const exists = fileExists ?? ((p) => existsSync(path.join(repoRoot, p)))
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
        if (!f.deleted && exists(f.path)) testDomain.targeted.push(rel)
        continue
      }
      // 一个文件可影响多个域：editor 的 src 同时喂 unit 与 integration，pkg-level
      // 文件喂两者——只取首个匹配域会静默漏掉 integration
      const affected = domains.filter((d) => d.affects(rel))
      if (affected.length > 0) for (const d of affected) d.full = true
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

/**
 * --check 的变更分类：返回 { mode: 'full', reason } 或
 * { mode: 'fast', plans, buildFilters, outside, hasRelated }。
 * plans 为可直接执行的扁平计划 { pkgName, label, args, desc }；
 * buildFilters 是前置 turbo build 的 --filter 参数（targeted-only 包 `<pkg>...` 保持
 * 原语义必缓存命中；related 包 `<pkg>^...` 只 build 上游 dist——vitest 直编本包 src，
 * 不消费自身 dist，跳过本包可能很重的 build，如 editor 的 electron-vite）。
 * fileExists 可注入以便单测（默认查磁盘）。
 */
export function classifyCheck(changed, pkgs, leafSet, fileExists) {
  const exists = fileExists ?? ((p) => existsSync(path.join(repoRoot, p)))
  if (changed.length === 0) {
    // 无变更也委托 turbo：缓存命中则秒过，未知状态交缓存语义兜底
    return { mode: 'full', reason: 'no changes detected' }
  }
  const testPkgs = pkgs.filter((p) => p.hasTest)
  const outside = []
  const byPkg = new Map()
  const bucket = (pkg, label) => {
    let entry = byPkg.get(pkg.name)
    if (!entry) {
      entry = { pkg, domains: new Map() }
      byPkg.set(pkg.name, entry)
    }
    let dom = entry.domains.get(label)
    if (!dom) {
      dom = { targeted: [], related: [] }
      entry.domains.set(label, dom)
    }
    return dom
  }

  for (const f of changed) {
    if (CHECK_FULL_RUN_FILES.has(f.path)) {
      return { mode: 'full', reason: `global file changed: ${f.path}` }
    }
    const pkg = testPkgs.find((p) => f.path.startsWith(`${p.root}/`))
    if (!pkg) {
      outside.push(f.path)
      continue
    }
    const rel = f.path.slice(pkg.root.length + 1)
    const domains = domainsFor(pkg.name)
    const testDomain = domains.find((d) => d.isTest(rel))
    if (testDomain) {
      if (!f.deleted && exists(f.path)) bucket(pkg, testDomain.label).targeted.push(rel)
      continue
    }
    if (domains.some((d) => d.isFull(rel))) {
      return { mode: 'full', reason: `config-level file changed: ${f.path}` }
    }
    const relatedDomains = domains.filter((d) => d.isRelated(rel))
    if (relatedDomains.length > 0) {
      if (!leafSet.has(pkg.name)) {
        return {
          mode: 'full',
          reason: `non-leaf package source changed: ${f.path} (downstream packages import its dist, out of related's reach)`,
        }
      }
      if (f.deleted || !exists(f.path)) {
        return { mode: 'full', reason: `source file deleted: ${f.path} (cannot build import graph)` }
      }
      for (const d of relatedDomains) bucket(pkg, d.label).related.push(rel)
      continue
    }
    outside.push(f.path)
  }

  const plans = []
  const buildFilters = []
  let hasRelated = false
  for (const { pkg, domains } of byPkg.values()) {
    const domainDefs = domainsFor(pkg.name)
    let pkgHasRelated = false
    for (const [label, dom] of domains) {
      const def = domainDefs.find((d) => d.label === label)
      if (dom.targeted.length > 0) {
        plans.push({
          pkgName: pkg.name,
          label: `${label} targeted`,
          args: def.run(dom.targeted),
          desc: `${dom.targeted.length} changed test file(s)`,
        })
      }
      if (dom.related.length > 0) {
        pkgHasRelated = true
        const abs = dom.related.map((rel) =>
          path.join(repoRoot, pkg.root, rel).replace(/\\/g, '/'),
        )
        plans.push({
          pkgName: pkg.name,
          label: `${label} related`,
          args: def.relatedRun(abs),
          desc: `tests importing ${dom.related.length} changed source file(s)`,
        })
      }
    }
    if (pkgHasRelated) {
      hasRelated = true
      buildFilters.push(`${pkg.name}^...`)
    } else {
      buildFilters.push(`${pkg.name}...`)
    }
  }
  return { mode: 'fast', plans, buildFilters, outside, hasRelated }
}

function runPlans(plans) {
  const failed = []
  for (const p of plans) {
    console.log(`\n▶ ${p.pkgName} [${p.label}] — ${p.desc}`)
    const r = spawnSync('pnpm', ['--filter', p.pkgName, ...p.args], {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    if (r.status !== 0) failed.push(`${p.pkgName} [${p.label}]`)
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
  const cls = classifyCheck(changed, pkgs, buildLeafSet(pkgs))

  if (cls.mode === 'full') {
    console.log(`test-changed: ${cls.reason} → delegating to turbo full run`)
    pnpm(['exec', 'turbo', 'run', 'lint', 'typecheck', 'test'])
    return
  }

  console.log(`test-changed: fast mode (base: ${baseRef ?? 'uncommitted changes'})`)
  for (const p of cls.plans) console.log(`  ${p.pkgName} [${p.label}] — ${p.desc}`)
  if (cls.hasRelated) {
    console.log(
      'ℹ related 按静态 import 图选测试（动态 import / 配置注入不在图内），CI 全量兜底；需全量语义用 pnpm check:full',
    )
  }

  pnpm(['exec', 'turbo', 'run', 'lint', 'typecheck'])

  if (cls.plans.length > 0) {
    // targeted/related 绕过 turbo test，丢失 dependsOn ^build 的 dist 新鲜度保证，先补 build
    //（filter 语义见 classifyCheck 注释；前提：所有包的 vitest 均直编 src、不 import 自身 dist）
    // win32 走 cmd（pnpm() shell:true），裸 ^ 是 cmd 转义符会被吞成 `pkg...`（含自身），
    // 双引号内 ^ 字面保留，且引号经 pnpm.CMD → node 逐层正确剥除
    const quoteFilter = (f) =>
      process.platform === 'win32' ? `"--filter=${f}"` : `--filter=${f}`
    pnpm(['exec', 'turbo', 'run', 'build', ...cls.buildFilters.map(quoteFilter)])
    const failed = runPlans(cls.plans)
    if (failed.length > 0) {
      console.error(`\ntest-changed: FAILED — ${failed.join(', ')}`)
      process.exit(1)
    }
  } else {
    console.log('test-changed: no test-affecting changes, skipping vitest')
  }
  printOutside(cls.outside)
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

  const pkgs = discoverPackages().filter((p) => p.hasTest)
  const { plans, outside, runAll } = buildPlans(changed, pkgs)
  if (runAll) {
    console.log('test-changed: lockfile/workspace changed, running full test suites')
  }
  if (plans.length === 0) {
    console.log('test-changed: no test-affecting changes, nothing to run')
    printOutside(outside)
    return
  }

  const flat = plans.flatMap((plan) =>
    plan.domains.map((d) => ({
      pkgName: plan.pkg.name,
      label: d.label,
      args: d.run(d.full ? [] : d.targeted),
      desc: d.full ? 'full suite' : `${d.targeted.length} changed file(s)`,
    })),
  )
  const failed = runPlans(flat)
  printOutside(outside)
  if (failed.length > 0) {
    console.error(`\ntest-changed: FAILED — ${failed.join(', ')}`)
    process.exit(1)
  }
  console.log('\ntest-changed: all passed')
}

// Only run the CLI when invoked directly (not when imported by the test).
const invokedDirectly =
  process.argv[1] &&
  realpathSync(process.argv[1]).split(path.sep).join('/') ===
    fileURLToPath(import.meta.url).split(path.sep).join('/')
if (invokedDirectly) {
  main()
}
