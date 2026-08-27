#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  electron-builder 打包入口包装：在打包前 loadEnv()，并把更新 feed 地址
 *  UE_UPDATE_FEED_URL 注入 process.env（未配置时回填占位值兜底），保证
 *  electron-builder.yml 里的 `${env.UE_UPDATE_FEED_URL}` 总能展开。
 *
 *  参数原样透传给 electron-builder。打包脚本（apps/editor/package.json 的
 *  package:win* / package:linux:dir）把 `electron-builder ...` 换成
 *  `node ../../scripts/release/package.mjs ...` 即接入。
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from '../lib/env.mjs'

loadEnv()

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')
const editorRoot = join(repoRoot, 'apps/editor')

// RFC 保留段占位值：没配 env 时产出指向占位地址的包（构建不失败）。
const UPDATE_FEED_URL_PLACEHOLDER = 'http://gallery.example.com:9999/universe-editor/'
if (!process.env.UE_UPDATE_FEED_URL) {
  process.env.UE_UPDATE_FEED_URL = UPDATE_FEED_URL_PLACEHOLDER
}

const electronBuilderPkg = createRequire(join(editorRoot, 'package.json')).resolve(
  'electron-builder/package.json',
)
const electronBuilderCli = join(dirname(electronBuilderPkg), 'cli.js')

const result = spawnSync(process.execPath, [electronBuilderCli, ...process.argv.slice(2)], {
  cwd: editorRoot,
  stdio: 'inherit',
})
if (result.error) {
  console.error(`electron-builder 启动失败: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
