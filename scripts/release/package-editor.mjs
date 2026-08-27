#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  electron-builder 打包入口：统一承接 package:win* / package:linux:dir 的完整打包链。
 *
 *  package.json 里的打包脚本原本是 `runtime:stage && build && package.mjs && verify`
 *  用 `&&` 串起来的；pnpm 的 `-- <args>` 透传只会把参数追加到链尾，`--env <mode>`
 *  到不了 loadEnv，导致 `pnpm ... package:win -- --env prod` 读不到 .env.prod。
 *  这里在最前面 loadEnv()（显式 mode 会回写 process.env.UE_ENV 供后续子进程继承），
 *  再按固定顺序跑四步，使 `--env` 真正生效。
 *
 *  参数：
 *    --env <mode>         传给 loadEnv 选 .env.<mode>（可选，默认 dev）
 *    --verify-root <path> verify-packaged 的 resources 根（可选，默认 win-unpacked）
 *    其余参数原样透传给 scripts/release/package.mjs（electron-builder 参数）。
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from '../lib/env.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')

// 剥离本入口自用的参数（--env 交给 loadEnv，--verify-root 交给 verify 步骤），
// 其余参数原样透传给 electron-builder。
export function splitArgs(argv) {
  const builderArgs = []
  let verifyRoot
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--env') {
      i++
      continue
    }
    if (arg.startsWith('--env=')) continue
    if (arg === '--verify-root') {
      verifyRoot = argv[++i]
      continue
    }
    if (arg.startsWith('--verify-root=')) {
      verifyRoot = arg.slice('--verify-root='.length)
      continue
    }
    builderArgs.push(arg)
  }
  return { builderArgs, verifyRoot }
}

function run(command, args) {
  // win32 上 pnpm 是 .cmd 包装脚本，spawnSync 必须走 shell；node 直接用 process.execPath。
  const shell = process.platform === 'win32' && command === 'pnpm'
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit', shell })
  if (result.error) {
    console.error(`✗ ${command} 启动失败: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function main(argv) {
  const { builderArgs, verifyRoot } = splitArgs(argv)

  run('pnpm', ['-w', 'run', 'runtime:stage'])
  run('pnpm', ['--filter', '@universe-editor/editor...', 'build'])
  run(process.execPath, [join(__dirname, 'package.mjs'), ...builderArgs])

  const verifyArgs = ['verify-packaged']
  if (verifyRoot) verifyArgs.push(verifyRoot)
  run(process.execPath, [join(__dirname, 'runtime-resources.mjs'), ...verifyArgs])
}

const isMain =
  process.argv[1] &&
  realpathSync(process.argv[1]).split(sep).join('/') ===
    fileURLToPath(import.meta.url)
      .split(sep)
      .join('/')
if (isMain) {
  loadEnv()
  main(process.argv.slice(2))
}
