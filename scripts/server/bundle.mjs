#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  把 server.mjs + publish API 依赖（extension-packaging / adm-zip / gallery/lib.mjs）
 *  打包成单文件产物 scripts/server/dist/server.js。
 *
 *  背景：publish 端点需要解 zip（adm-zip）与 zod 校验，打破了 server.mjs 曾经"拷一个文件
 *  就能跑"的部署不变式。打包恢复这一体验——部署方在仓库内跑本脚本，再把 scripts/server/
 *  整目录（含 dist/）拷到服务器跑 setup.sh/setup.ps1 即可，服务器上无需仓库与 node_modules。
 *
 *  用法:
 *    pnpm server:bundle                  只出 dist/server.js（服务器侧用默认值/已有配置）
 *    pnpm server:bundle -- --env prod    同时按 .env.prod 生成 dist/server.env，让首装即带配置
 *
 *  .env 只在开发机存在（服务器上没有仓库），所以 .env → server.env 的转换固定发生在这里；
 *  setup 只消费生成好的 server.env。deploy 部署时会自动透传 --env，与首装共用同一套生成逻辑。
 *--------------------------------------------------------------------------------------------*/

import { build } from 'esbuild'
import { writeFileSync, rmSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasExplicitMode, loadEnv } from '../lib/env.mjs'
import { SERVER_ENV_FILE, isWindowsPath, renderServerEnv } from './serverEnv.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const envOutput = resolve(__dirname, 'dist', SERVER_ENV_FILE)

await build({
  entryPoints: [resolve(__dirname, 'server.mjs')],
  outfile: resolve(__dirname, 'dist', 'server.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // ESM 产物里内联的 CJS 依赖（adm-zip）需要 require——用 createRequire 补一个，
  // 否则 esbuild 的 __require 兜底会抛 "Dynamic require of fs is not supported"。
  banner: {
    js: "import { createRequire as __ueCreateRequire } from 'node:module'; const require = __ueCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
})

console.log('✓ dist/server.js 已生成（单文件，含 publish API 全部依赖）')

// 只有显式 --env/UE_ENV 才生成 server.env——不指定时默认 mode 是 dev，
// 静默把开发机的 dev 配置打进产物、拷到生产服务器是危险的默认行为。
if (!hasExplicitMode(process.argv.slice(2), process.env)) {
  // 清掉上一次带 --env 跑留下的产物，避免陈旧配置被误拷到服务器。
  if (existsSync(envOutput)) {
    rmSync(envOutput)
    console.log('  （已清理上次生成的 dist/server.env；需要随包带配置请加 --env <mode>）')
  }
} else {
  const { mode } = loadEnv()
  // 目标平台：优先看安装目录形态，其次看发布根——Windows 远端要用反斜杠路径与 CRLF。
  const windows = isWindowsPath(process.env.UE_SERVER_APP_DIR ?? process.env.UE_SERVER_ROOT ?? '')
  const { text, keys } = renderServerEnv({ env: process.env, windows, mode })
  writeFileSync(envOutput, text)
  console.log(
    `✓ dist/${SERVER_ENV_FILE} 已生成（${mode} / ${windows ? 'Windows' : 'Linux'} 目标，${keys.length} 项）`,
  )
  console.log(`  ${keys.join(', ')}`)
}
