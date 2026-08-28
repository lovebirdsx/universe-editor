// `pnpm dev` 入口 wrapper：在命令行敲下的这一刻记下 T0（epoch ms），透传给
// electron-vite spawn 出的 Electron 主进程（env UNIVERSE_DEV_T0）。main 端据此
// 打印「pnpm dev → 窗口可响应」的完整墙钟——这段包含 electron-vite 编译三端 +
// spawn electron，进程内 perf mark 覆盖不到，只有从这里记 T0 才测得到。
//
// 根 `pnpm dev` 直接执行本脚本（不再经 `pnpm --filter editor dev` 的第二层 pnpm，
// Windows 上每层 pnpm 启动 ~0.7s），所以 vendored 依赖检查（原 predev 钩子）也在
// 这里前置执行，保证两条入口行为一致。
import { spawn, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { loadEnv } from '../../../scripts/lib/env.mjs'
import { collectConfigurationDefaults } from '../../../scripts/lib/productDefaults.mjs'

const APP_ROOT = resolve(import.meta.dirname, '..')
const REPO_ROOT = resolve(APP_ROOT, '../..')
const ELECTRON_VITE_BIN = resolve(APP_ROOT, 'node_modules/electron-vite/bin/electron-vite.js')

// 读 .env* 让 dev 会话拿到和打包版同一套内置配置默认值（映射表见 scripts/lib/
// productDefaults.mjs）。产物侧走 resources/product.json，dev 侧靠下面这个环境变量。
loadEnv({ cwd: REPO_ROOT })
const configurationDefaults = collectConfigurationDefaults()

const vendor = spawnSync(
  process.execPath,
  [resolve(REPO_ROOT, 'scripts/release/vendor-install.mjs')],
  { cwd: REPO_ROOT, stdio: 'inherit' },
)
if (vendor.status !== 0) process.exit(vendor.status ?? 1)

// Bundled-into-main workspace packages must have their dist/ built before
// electron-vite resolves them (see scripts/dev/ensure-workspace-build.mjs). Fast no-op
// once present; only a fresh clone / cleaned dist pays the turbo build.
const upstream = spawnSync(
  process.execPath,
  [resolve(REPO_ROOT, 'scripts/dev/ensure-workspace-build.mjs')],
  { cwd: REPO_ROOT, stdio: 'inherit' },
)
if (upstream.status !== 0) process.exit(upstream.status ?? 1)

// The remote-server deploy bundle is content-hashed on connect; keep dist-bundle fresh
// before launching so a stale/missing bundle can't fail-open past the staleness check.
// Fast no-op once stamped; only input changes pay the esbuild bundle.
const remoteServerBundle = spawnSync(
  process.execPath,
  [resolve(REPO_ROOT, 'scripts/dev/ensure-remote-server-bundle.mjs')],
  { cwd: REPO_ROOT, stdio: 'inherit' },
)
if (remoteServerBundle.status !== 0) process.exit(remoteServerBundle.status ?? 1)

// ELECTRON_RUN_AS_NODE leaks in from an agent/tooling shell would make electron-vite
// spawn the ESM main process in plain-node mode and crash it. Strip it here so a
// stray export in the caller's environment can't break `pnpm dev`.
const { ELECTRON_RUN_AS_NODE: _drop, ...cleanEnv } = process.env

// Watch the bundle inputs so a dev session edits remote-server/extension-host sources
// keep dist-bundle fresh (the precheck above only guarantees startup freshness). Runs
// alongside electron-vite; killed when it exits so no orphan watch survives.
const REMOTE_SERVER_ESBUILD = resolve(REPO_ROOT, 'packages/remote-server/esbuild.config.mjs')
const remoteWatch = spawn(process.execPath, [REMOTE_SERVER_ESBUILD, '--watch', '--bundle'], {
  cwd: resolve(REPO_ROOT, 'packages/remote-server'),
  stdio: 'inherit',
  env: cleanEnv,
})

const child = spawn(process.execPath, [ELECTRON_VITE_BIN, 'dev', ...process.argv.slice(2)], {
  cwd: APP_ROOT,
  stdio: 'inherit',
  env: {
    ...cleanEnv,
    UNIVERSE_DEV_T0: String(Date.now()),
    ...(configurationDefaults
      ? { UNIVERSE_CONFIGURATION_DEFAULTS: JSON.stringify(configurationDefaults) }
      : {}),
  },
})

child.on('exit', (code, signal) => {
  remoteWatch.kill()
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
