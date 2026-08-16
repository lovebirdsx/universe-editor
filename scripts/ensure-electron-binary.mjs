/*---------------------------------------------------------------------------------------------
 *  ensure-electron-binary.mjs — install 钩子守卫，自愈「依赖已装但 electron 二进制缺失」的
 *  静默状态。该状态来自 postinstall 被中断/跳过，且 pnpm 之后不会再重跑 electron 的构建
 *  脚本；若不修复，每个 vitest worker 会在 require('electron') 时各自现场下载 220MB 二进制。
 *
 *  正常路径（二进制齐全）零输出、秒退；缺失时调用 electron 自带的 install.js 补齐
 *  （走 ~/.cache/electron 缓存），失败则非零退出让 pnpm install 大声失败。
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD === '1') {
  process.exit(0)
}

let electronPkgPath
try {
  const editorPkgPath = fileURLToPath(new URL('../apps/editor/package.json', import.meta.url))
  const requireFromEditor = createRequire(editorPkgPath)
  electronPkgPath = requireFromEditor.resolve('electron/package.json')
} catch {
  process.exit(0)
}

const pkgDir = path.dirname(electronPkgPath)

if (isComplete(pkgDir)) {
  process.exit(0)
}

console.log('electron binary missing, running electron install.js ...')

const install = spawnSync(process.execPath, [path.join(pkgDir, 'install.js')], {
  stdio: 'inherit',
  cwd: pkgDir,
})

if (install.status !== 0) {
  process.exit(install.status ?? 1)
}

if (!isComplete(pkgDir)) {
  console.error('electron install.js finished but binary is still incomplete')
  process.exit(1)
}

function isComplete(dir) {
  const pathTxt = path.join(dir, 'path.txt')
  const distVersionPath = path.join(dir, 'dist', 'version')
  const pkgJsonPath = path.join(dir, 'package.json')

  if (!existsSync(pathTxt)) return false

  let exeName
  let distVersion
  let pkgVersion
  try {
    exeName = readFileSync(pathTxt, 'utf8').trim()
    distVersion = readFileSync(distVersionPath, 'utf8').trim().replace(/^v/, '')
    pkgVersion = JSON.parse(readFileSync(pkgJsonPath, 'utf8')).version
  } catch {
    return false
  }

  if (!exeName) return false
  if (!existsSync(path.join(dir, 'dist', exeName))) return false

  return distVersion === pkgVersion
}
