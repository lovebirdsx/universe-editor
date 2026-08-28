// `pnpm dev:run` 入口 wrapper：构建一份 **dev-flavor** 产物到 `out-dev/`，再用 Electron
// 直接加载运行（无 dev server / HMR / watch）。走和 `pnpm dev` 相同的 dev 身份
// （import.meta.env.DEV === true → `Universe Editor - Dev` 数据目录 + dev-only 特性）。
//
// 快的关键——两级增量跳过（否则每次全量三端 build ~5s，比 `pnpm dev` 弹窗还慢）：
//  1. 按端输入指纹：main / preload / renderer 各自对输入源码算指纹（mtime+size 聚合
//     hash，存 `out-dev/.devrun-stamp.json`），没变的端直接跳过 build。什么都没改时
//     整个 build 段消失，秒到 Electron spawn；只改 main 时省掉 renderer 的大头。
//     指纹漏判兜底：`pnpm dev:run --force`（或 UNIVERSE_DEVRUN_FORCE=1）强制全量。
//  2. build 在自调用的短命子进程里直调 electron-vite 的 resolveConfig + vite build
//     （等效复刻其 build()——它本身只是对三端串行调 vite build——但可按端过滤）。
//     必须是子进程：实测同一进程先跑 vite build 再 spawn Electron，main 会卡死在
//     服务创建阶段（build 留下的进程级状态干扰子进程；隔离到子进程后消失）。
//
// 产物隔离：dev-flavor 构建落到 `out-dev/`（由 electron.vite.config.ts 据 UNIVERSE_DEV_BUILD
// 切换），不碰生产/e2e 用的 `out/`。Electron 以 out-dev 目录为入口启动（见下方 manifest
// 播种注释）；main 用 import.meta.dirname 相对定位 preload/renderer，自然跟随到 out-dev/*。
//
// dev-flavor 的关键：electron-vite build 会在加载配置前硬设 NODE_ENV=production，把
// import.meta.env.DEV 烤成 false。这里设 UNIVERSE_DEV_BUILD=1，electron.vite.config.ts
// 在加载时据此把 NODE_ENV 翻回 development（config 晚于 electron-vite 的赋值，故生效）。
//
// build 完成后记下 T0（epoch ms），透传给 spawn 出的 Electron 主进程（env
// UNIVERSE_DEVRUN_T0）。main 端据此打印「pnpm dev:run → 窗口可响应」的启动墙钟；T0 记在
// build 之后、spawn 之前，测的是纯「产物冷启动」而非构建耗时。
//
// 与 `pnpm dev`（scripts/dev.mjs）对称：根 `pnpm dev:run` 与 `pnpm --filter editor dev:run`
// 都汇聚到本脚本，vendored 依赖检查（原 predev 钩子）也在这里前置执行以保持一致。
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { loadEnv } from '../../../scripts/lib/env.mjs'
import { collectConfigurationDefaults } from '../../../scripts/lib/productDefaults.mjs'

const APP_ROOT = resolve(import.meta.dirname, '..')
const REPO_ROOT = resolve(APP_ROOT, '../..')
const OUT_DEV = resolve(APP_ROOT, 'out-dev')
const STAMP_FILE = resolve(OUT_DEV, '.devrun-stamp.json')
const STAMP_VERSION = 1

const BUILD_CHILD_FLAG = '--build-child'

// 子进程 build 分支：`node dev-run.mjs --build-child <target...>`。scripts/ 位于
// apps/editor 下，裸导入即解析到 editor 的 electron-vite 与 vite（rolldown-vite）。
if (process.argv[2] === BUILD_CHILD_FLAG) {
  const targets = process.argv.slice(3)
  process.chdir(APP_ROOT)
  process.env.UNIVERSE_DEV_BUILD = '1'
  process.env.NODE_ENV_ELECTRON_VITE = 'production'
  const [{ resolveConfig }, { build: viteBuild }] = await Promise.all([
    import('electron-vite'),
    import('vite'),
  ])
  const resolved = await resolveConfig({ root: APP_ROOT, logLevel: 'info' }, 'build', 'production')
  for (const name of targets) {
    const viteConfig = resolved.config?.[name]
    if (!viteConfig) continue
    if (viteConfig.build?.watch) viteConfig.build.watch = null
    await viteBuild(viteConfig)
  }
  process.exit(0)
}

const args = process.argv.slice(2)
const force = args.includes('--force') || process.env.UNIVERSE_DEVRUN_FORCE === '1'
const electronArgs = args.filter((a) => a !== '--force')

// 读 .env* 让 dev:run 与 pnpm dev 拿到同一套内置配置默认值（scripts/lib/productDefaults.mjs）。
// 放在 build-child 早退之后：子进程只跑 vite build，不需要也不该重复打 [env] 日志。
loadEnv({ cwd: REPO_ROOT })
const configurationDefaults = collectConfigurationDefaults()

const vendor = spawnSync(
  process.execPath,
  [resolve(REPO_ROOT, 'scripts/release/vendor-install.mjs')],
  { cwd: REPO_ROOT, stdio: 'inherit' },
)
if (vendor.status !== 0) process.exit(vendor.status ?? 1)

// Bundled-into-main workspace packages must have their dist/ built before the
// electron-vite build below resolves them (see scripts/dev/ensure-workspace-build.mjs).
// Fast no-op once present; only a fresh clone / cleaned dist pays the turbo build.
const upstream = spawnSync(
  process.execPath,
  [resolve(REPO_ROOT, 'scripts/dev/ensure-workspace-build.mjs')],
  { cwd: REPO_ROOT, stdio: 'inherit' },
)
if (upstream.status !== 0) process.exit(upstream.status ?? 1)

// Same remote-server bundle freshness gate as `pnpm dev` (see scripts/dev/
// ensure-remote-server-bundle.mjs). dev:run has no watch semantics, so this precheck
// is the only freshness guarantee — the deploy hash must not fail-open on a stale bundle.
const remoteServerBundle = spawnSync(
  process.execPath,
  [resolve(REPO_ROOT, 'scripts/dev/ensure-remote-server-bundle.mjs')],
  { cwd: REPO_ROOT, stdio: 'inherit' },
)
if (remoteServerBundle.status !== 0) process.exit(remoteServerBundle.status ?? 1)

// ---------------------------------------------------------------------------
// 按端输入指纹。GLOBAL_INPUTS 是三端公共输入（config / 插件 / 共享源码 / 依赖清单），
// 任一变化三端全建；各端 inputs 只列独有目录。清单须跟 electron.vite.config.ts 对齐：
//  - main 把 platform（alias → src）与另外 4 个 workspace 包（node 解析 → dist）打进
//    bundle（externalizeDeps.exclude），故 main 吃 platform/src + 其余包的 dist
//  - renderer 的 alias 全指向各包 src；preload 无 alias，只吃自身 + shared
// 宁可多列（多触发一次重建）不可漏列（stale 产物比慢更糟）。

const GLOBAL_INPUTS = [
  'apps/editor/scripts/dev-run.mjs',
  'apps/editor/electron.vite.config.ts',
  'apps/editor/build',
  'apps/editor/package.json',
  'apps/editor/tsconfig.json',
  'apps/editor/tsconfig.node.json',
  'apps/editor/tsconfig.web.json',
  'apps/editor/src/shared',
  'pnpm-lock.yaml',
]

const TARGETS = {
  main: {
    entry: 'out-dev/main/index.js',
    inputs: [
      'apps/editor/src/main',
      'packages/platform/src',
      'packages/extensions-common/dist',
      'packages/extension-api/dist',
      'packages/extension-gallery/dist',
      'packages/extension-packaging/dist',
    ],
  },
  preload: {
    entry: 'out-dev/preload/index.cjs',
    inputs: ['apps/editor/src/preload'],
  },
  renderer: {
    entry: 'out-dev/renderer/index.html',
    inputs: [
      'apps/editor/src/renderer',
      'apps/editor/public',
      'packages/platform/src',
      'packages/workbench-ui/src',
      'packages/extensions-common/src',
    ],
  },
}

// 测试文件不进 bundle，跳过以免「只改测试」触发整端重建。
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
  for (const rel of inputs) collectEntries(resolve(REPO_ROOT, rel), out)
  out.sort()
  return createHash('sha256').update(out.join('\n')).digest('hex')
}

const tFingerprint = Date.now()
const globalHash = fingerprint(GLOBAL_INPUTS)
const currentHashes = {}
for (const [name, target] of Object.entries(TARGETS)) {
  currentHashes[name] = createHash('sha256')
    .update(globalHash)
    .update(fingerprint(target.inputs))
    .digest('hex')
}

let stampedHashes = {}
try {
  const stamp = JSON.parse(readFileSync(STAMP_FILE, 'utf8'))
  if (stamp.version === STAMP_VERSION) stampedHashes = stamp.targets ?? {}
} catch {
  // 首跑 / stamp 损坏 → 全量
}

const dirty = Object.entries(TARGETS)
  .filter(
    ([name, target]) =>
      force ||
      stampedHashes[name] !== currentHashes[name] ||
      !existsSync(resolve(APP_ROOT, target.entry)),
  )
  .map(([name]) => name)

console.log(
  `[dev-run] fingerprint ${Date.now() - tFingerprint}ms — ` +
    (dirty.length
      ? `rebuilding: ${dirty.join(', ')}${force ? ' (forced)' : ''}`
      : 'all targets up to date, skipping build'),
)

// ELECTRON_RUN_AS_NODE leaks in from an agent/tooling shell would make Electron
// boot in plain-node mode instead of loading the app. Strip it here so a stray
// export in the caller's environment can't break `pnpm dev:run`.
const { ELECTRON_RUN_AS_NODE: _drop, ...cleanEnv } = process.env

if (dirty.length > 0) {
  const tBuild = Date.now()
  const build = spawnSync(process.execPath, [import.meta.filename, BUILD_CHILD_FLAG, ...dirty], {
    cwd: APP_ROOT,
    stdio: 'inherit',
    env: cleanEnv,
  })
  if (build.status !== 0) process.exit(build.status ?? 1)
  writeFileSync(
    STAMP_FILE,
    JSON.stringify({ version: STAMP_VERSION, targets: currentHashes }, null, 2),
  )
  console.log(`[dev-run] build ${dirty.join('+')}: ${Date.now() - tBuild}ms`)
}

// electron's npm package default-exports the path to its executable when imported
// from a plain node process.
const electronExe = createRequire(import.meta.url)('electron')

// Launch with a DIRECTORY entry (like `pnpm dev`'s `electron .`), not the main
// file: Electron only loads package.json for directory entries, so a file entry
// leaves app.getVersion()/getName() at the Electron binary's own version/name.
// Seed a minimal manifest so both entries agree. Must run after the build (vite
// empties each target's outDir) and is content-gated to avoid pointless writes.
{
  const pkg = JSON.parse(readFileSync(resolve(APP_ROOT, 'package.json'), 'utf8'))
  const manifest = `${JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module', main: 'main/index.js' }, null, 2)}\n`
  const manifestPath = resolve(OUT_DEV, 'package.json')
  if (!existsSync(manifestPath) || readFileSync(manifestPath, 'utf8') !== manifest) {
    writeFileSync(manifestPath, manifest)
  }
}

const t0 = Date.now()
const child = spawn(electronExe, [OUT_DEV, ...electronArgs], {
  cwd: APP_ROOT,
  stdio: 'inherit',
  env: {
    ...cleanEnv,
    UNIVERSE_DEVRUN_T0: String(t0),
    ...(configurationDefaults
      ? { UNIVERSE_CONFIGURATION_DEFAULTS: JSON.stringify(configurationDefaults) }
      : {}),
  },
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
