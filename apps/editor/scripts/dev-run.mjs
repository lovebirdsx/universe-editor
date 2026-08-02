// `pnpm dev:run` 入口 wrapper：先 `electron-vite build` 出一份 **dev-flavor** 产物，
// 再用 Electron 直接加载该产物运行（无 dev server / HMR / watch）。目的是快速验证本地
// 改动——构建一次直接跑，走和 `pnpm dev` 相同的 dev 身份（import.meta.env.DEV === true
// → `Universe Editor - Dev` 数据目录 + dev-only 特性），只是不带热更。
//
// 产物隔离：dev-flavor 构建落到 `out-dev/`（由 electron.vite.config.ts 据 UNIVERSE_DEV_BUILD
// 切换），不碰生产/e2e 用的 `out/`。Electron 直接以 out-dev/main/index.js 为入口启动；
// main 用 import.meta.dirname 相对定位 preload/renderer，自然跟随到 out-dev/*，与 e2e
// 「electron out/main/index.js」布局同理（getAppPath 向上走查仓库相对路径也已容忍这种布局）。
//
// build 完成后记下 T0（epoch ms），透传给 spawn 出的 Electron 主进程（env
// UNIVERSE_DEVRUN_T0）。main 端据此打印「pnpm dev:run → 窗口可响应」的启动墙钟；无
// dev-server 编译段，T0 记在 build 之后、spawn 之前，测的是纯「产物冷启动」而非构建耗时。
//
// 与 `pnpm dev`（scripts/dev.mjs）对称：根 `pnpm dev:run` 与 `pnpm --filter editor dev:run`
// 都汇聚到本脚本，vendored 依赖检查（原 predev 钩子）也在这里前置执行以保持一致。
//
// dev-flavor 的关键：electron-vite build 会在加载配置前硬设 NODE_ENV=production，把
// import.meta.env.DEV 烤成 false。这里传 UNIVERSE_DEV_BUILD=1，electron.vite.config.ts
// 在加载时据此把 NODE_ENV 翻回 development（config 晚于 electron-vite 的赋值，故生效）。
import { spawn, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'

const APP_ROOT = resolve(import.meta.dirname, '..')
const REPO_ROOT = resolve(APP_ROOT, '../..')
const ELECTRON_VITE_BIN = resolve(APP_ROOT, 'node_modules/electron-vite/bin/electron-vite.js')
const DEV_MAIN_ENTRY = resolve(APP_ROOT, 'out-dev/main/index.js')

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

// ELECTRON_RUN_AS_NODE leaks in from an agent/tooling shell would make Electron
// boot in plain-node mode instead of loading the app. Strip it here so a stray
// export in the caller's environment can't break `pnpm dev:run`.
const { ELECTRON_RUN_AS_NODE: _drop, ...cleanEnv } = process.env

// Build a one-shot dev-flavor bundle into out-dev/. UNIVERSE_DEV_BUILD=1 makes the
// config flip NODE_ENV back to development (so import.meta.env.DEV stays true) and
// redirect the outDir. Build time is intentionally excluded from the wall clock below.
const build = spawnSync(process.execPath, [ELECTRON_VITE_BIN, 'build'], {
  cwd: APP_ROOT,
  stdio: 'inherit',
  env: { ...cleanEnv, UNIVERSE_DEV_BUILD: '1' },
})
if (build.status !== 0) process.exit(build.status ?? 1)

// electron's npm package default-exports the path to its executable when imported
// from a plain node process.
const electronExe = createRequire(import.meta.url)('electron')

const t0 = Date.now()
const child = spawn(electronExe, [DEV_MAIN_ENTRY, ...process.argv.slice(2)], {
  cwd: APP_ROOT,
  stdio: 'inherit',
  env: { ...cleanEnv, UNIVERSE_DEVRUN_T0: String(t0) },
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
