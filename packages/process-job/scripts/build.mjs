#!/usr/bin/env node
// 构建 Windows Job Object 原生 addon。非 win32 直接跳过（运行时降级为进程组/treeKill）。
// N-API ABI 稳定：用当前 Node 的头文件编译一次，Electron 里可直接 dlopen，无需 electron-rebuild。
//
// 工具链缺失（无 MSVC/python）时默认只告警不失败，让没有 C++ 工具链的开发者仍能 build；
// 发版/CI 用 --require（或 CI=true）强制失败，runtime:verify 也会再兜一道。
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'build', 'Release', 'process_job.node')
const required = process.argv.includes('--require') || process.env.CI === 'true'

function fail(message) {
  const log = required ? console.error : console.warn
  log(`[process-job] ${message}`)
  process.exit(required ? 1 : 0)
}

if (process.platform !== 'win32') {
  console.log('[process-job] skipped: Job Object addon is Windows-only')
  process.exit(0)
}
if (process.env.UNIVERSE_SKIP_NATIVE_BUILD === '1') {
  console.log('[process-job] skipped: UNIVERSE_SKIP_NATIVE_BUILD=1')
  process.exit(0)
}

function newestSourceMtime() {
  let newest = statSync(join(root, 'binding.gyp')).mtimeMs
  const dir = join(root, 'native')
  for (const name of readdirSync(dir)) newest = Math.max(newest, statSync(join(dir, name)).mtimeMs)
  return newest
}

if (existsSync(output) && statSync(output).mtimeMs >= newestSourceMtime()) {
  console.log('[process-job] up to date')
  process.exit(0)
}

let nodeGyp
try {
  nodeGyp = createRequire(join(root, 'package.json')).resolve('node-gyp/bin/node-gyp.js')
} catch {
  fail('node-gyp is not installed (run pnpm install)')
}

console.log('[process-job] node-gyp rebuild')
const result = spawnSync(process.execPath, [nodeGyp, 'rebuild', '--release'], {
  cwd: root,
  stdio: 'inherit',
})
if (result.status !== 0 || !existsSync(output)) {
  fail(
    `node-gyp rebuild failed (exit ${result.status}); Job Object containment will be unavailable`,
  )
}
console.log(`[process-job] built ${output}`)
