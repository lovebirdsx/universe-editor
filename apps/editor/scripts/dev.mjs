// `pnpm dev` 入口 wrapper：在命令行敲下的这一刻记下 T0（epoch ms），透传给
// electron-vite spawn 出的 Electron 主进程（env UNIVERSE_DEV_T0）。main 端据此
// 打印「pnpm dev → 窗口可响应」的完整墙钟——这段包含 electron-vite 编译三端 +
// spawn electron，进程内 perf mark 覆盖不到，只有从这里记 T0 才测得到。
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const APP_ROOT = resolve(import.meta.dirname, '..')
const ELECTRON_VITE_BIN = resolve(APP_ROOT, 'node_modules/electron-vite/bin/electron-vite.js')

// ELECTRON_RUN_AS_NODE leaks in from an agent/tooling shell would make electron-vite
// spawn the ESM main process in plain-node mode and crash it. Strip it here so a
// stray export in the caller's environment can't break `pnpm dev`.
const { ELECTRON_RUN_AS_NODE: _drop, ...cleanEnv } = process.env

const child = spawn(process.execPath, [ELECTRON_VITE_BIN, 'dev', ...process.argv.slice(2)], {
  cwd: APP_ROOT,
  stdio: 'inherit',
  env: { ...cleanEnv, UNIVERSE_DEV_T0: String(Date.now()) },
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
