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
 *  turbo's own cache keeps that a no-op once warm.
 *
 *  `pnpm dev` 自带 devRuntimeWatchPlugin（extensions/* 与 extension-host 的 esbuild
 *  --watch + 每次启动的 ext:build 刷新），产物新鲜度由它维护。`pnpm dev:run` 是
 *  production 模式构建、不挂载该插件、无任何 watch，本脚本的存在性检查成为唯一
 *  防线——所以额外跑一段 fingerprint 守卫（mtime+size 聚合，与 dev-run.mjs /
 *  ensure-remote-server-bundle.mjs 同款）：src 新于 dist 时跳过 turbo、直接对每个
 *  过期包跑 `esbuild.config.mjs` 单次构建（perforce 一条约 0.3s，比 turbo 调度
 *  ~1-2s 快得多）。指纹漏判兜底：`UNIVERSE_WORKSPACE_BUILD_FORCE=1` 强制全量重建。
 *
 *  输入面刻意放宽（宁多勿漏，漏了就是 stale 产物）：
 *   - extension-host bootstrap：bundle 进 src + 依赖包 dist（platform /
 *     extensions-common / extension-api 都 inline）
 *   - 各扩展 dist/extension.js：bundle 进 src + extension-api dist（extensions-common
 *     经 api/dist 的 d.ts 间接参与——tsgo project references 下它变了 api/dist 也变）
 *--------------------------------------------------------------------------------------------*/

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')

// ---------------------------------------------------------------------------
// Staleness guard 的指纹工具与包枚举（fast path 专用，dev:run 是主要受益方；
// dev 模式虽自带 watcher，跑一下也无妨——几毫秒，还能兜住 watcher 没跑起来的
// 窗口期）。

const STAMP_FILE = resolve(repoRoot, 'node_modules/.cache/ensure-workspace-build.json')
const STAMP_VERSION = 1

const SKIP_DIRS = new Set(['node_modules', '.git', '__tests__'])
const TEST_FILE_RE = /\.test\.[cm]?[jt]sx?$/

const entriesCache = new Map()

function collectEntries(abs, out) {
  const cached = entriesCache.get(abs)
  if (cached) {
    out.push(...cached)
    return
  }
  const own = []
  let st
  try {
    st = statSync(abs)
  } catch {
    // 目录/文件出现与消失同样要反映进指纹
    own.push(`${abs}|missing`)
    entriesCache.set(abs, own)
    out.push(...own)
    return
  }
  if (st.isFile()) {
    own.push(`${abs}|${st.mtimeMs}|${st.size}`)
  } else {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) collectEntries(join(abs, e.name), own)
      } else if (e.isFile() && !TEST_FILE_RE.test(e.name)) {
        const p = join(abs, e.name)
        const s = statSync(p)
        own.push(`${p}|${s.mtimeMs}|${s.size}`)
      }
    }
  }
  entriesCache.set(abs, own)
  out.push(...own)
}

function fingerprint(inputs) {
  const out = []
  for (const abs of inputs) collectEntries(abs, out)
  out.sort()
  return createHash('sha256').update(out.join('\n')).digest('hex')
}

// esbuild 运行时包（extension-host bootstrap + 各内置扩展 activation entry）的
// 输入面。只有带 esbuild.config.mjs 的目录会进表——与产物形态一一对应。
function esbuildRuntimeBundles() {
  const bundles = []
  const extHostDir = resolve(repoRoot, 'packages/extension-host')
  if (existsSync(resolve(extHostDir, 'esbuild.config.mjs'))) {
    bundles.push({
      label: '@universe-editor/extension-host',
      dir: extHostDir,
      output: resolve(extHostDir, 'dist/bootstrap.js'),
      inputs: [
        resolve(extHostDir, 'src'),
        resolve(extHostDir, 'esbuild.config.mjs'),
        resolve(repoRoot, 'packages/platform/dist'),
        resolve(repoRoot, 'packages/extensions-common/dist'),
        resolve(repoRoot, 'packages/extension-api/dist'),
      ],
    })
  }
  const extDir = resolve(repoRoot, 'extensions')
  if (existsSync(extDir)) {
    for (const entry of readdirSync(extDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = resolve(extDir, entry.name)
      const pkg = readPkg(dir)
      if (!pkg?.main || !existsSync(resolve(dir, 'esbuild.config.mjs'))) continue
      bundles.push({
        label: pkg.name ?? entry.name,
        dir,
        output: resolve(dir, pkg.main),
        inputs: [
          resolve(dir, 'src'),
          resolve(dir, 'esbuild.config.mjs'),
          resolve(repoRoot, 'packages/extension-api/dist'),
        ],
      })
    }
  }
  return bundles
}

// 返回 true = 无 stale（fast path 继续走 "all present" 输出）；false = 已按需重建
// 过期产物。全量路径（missing 非空）在 turbo 重建后也落到这里写章——此时指纹与
// 产物一致，不会再触发任何 esbuild，下次 fast path 才能命中 stamp 跳过。
function refreshStaleEsbuildBundles() {
  const t0 = Date.now()
  const forceAll = process.env.UNIVERSE_WORKSPACE_BUILD_FORCE === '1'
  const bundles = esbuildRuntimeBundles()
  const currentHashes = {}
  for (const b of bundles) currentHashes[b.label] = fingerprint(b.inputs)

  let stampedHashes = {}
  try {
    const stamp = JSON.parse(readFileSync(STAMP_FILE, 'utf8'))
    if (stamp.version === STAMP_VERSION) stampedHashes = stamp.bundles ?? {}
  } catch {
    // 首跑 / stamp 损坏 → 下方 stampedHashes[label] 全 undefined → 全量刷一遍
  }

  const stale = bundles.filter(
    (b) => forceAll || stampedHashes[b.label] !== currentHashes[b.label] || !existsSync(b.output),
  )
  if (stale.length === 0) return true

  console.log(
    `[ensure-workspace-build] refreshing stale bundles: ${stale.map((b) => b.label).join(', ')}${forceAll ? ' (forced)' : ''}…`,
  )
  for (const b of stale) {
    const t = Date.now()
    const res = spawnSync(process.execPath, ['esbuild.config.mjs'], {
      cwd: b.dir,
      stdio: 'inherit',
    })
    if (res.status !== 0) {
      console.error(`[ensure-workspace-build] esbuild failed for ${b.label}`)
      process.exit(res.status ?? 1)
    }
    console.log(`[ensure-workspace-build]   ${b.label}: ${Date.now() - t}ms`)
  }
  mkdirSync(dirname(STAMP_FILE), { recursive: true })
  writeFileSync(
    STAMP_FILE,
    JSON.stringify({ version: STAMP_VERSION, bundles: currentHashes }, null, 2) + '\n',
  )
  console.log(`[ensure-workspace-build] stale refresh done (${Date.now() - t0}ms)`)
  return false
}

// ---------------------------------------------------------------------------

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
  if (refreshStaleEsbuildBundles()) {
    console.log('[ensure-workspace-build] all workspace artifacts present — skipping build')
  }
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

// 全量 turbo 重建后产物即最新，落章让下次 fast path 命中（此时指纹与产物一致，
// 不会再触发任何 esbuild——除非输入与构建并发变化，那是下一次运行的事）。
refreshStaleEsbuildBundles()
