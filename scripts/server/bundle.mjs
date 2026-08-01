#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  把 server.mjs + publish API 依赖（extension-packaging / adm-zip / zod / gallery/lib.mjs）
 *  打包成单文件产物 scripts/server/dist/server.js。
 *
 *  背景：publish 端点需要解 zip（adm-zip）与 zod 校验，打破了 server.mjs 曾经"拷一个文件
 *  就能跑"的部署不变式。打包恢复这一体验——部署方在仓库内跑本脚本，再把 scripts/server/
 *  整目录（含 dist/）拷到服务器跑 setup.sh/setup.ps1 即可，服务器上无需仓库与 node_modules。
 *
 *  用法:  pnpm server:bundle
 *--------------------------------------------------------------------------------------------*/

import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

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
