#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  从本地 stage 的市场 registry 下架某扩展或某版本。
 *
 *  用法（在仓库根目录）:
 *    node scripts/gallery/unpublish.mjs --stage <stageDir> <publisher>.<name>[@<version>]
 *
 *  删 registry 条目 + 删对应 assets 目录。之后照常用 upload.mjs 同步（registry.json 最后覆盖）。
 *  注意：删了本地 assets 目录后 upload 用 scp 不会删除服务器上已存在的旧目录——如需彻底清理，
 *  按提示到服务器手动删对应 assets 子目录。
 *--------------------------------------------------------------------------------------------*/

import { rmSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { readRegistry, writeRegistry, removeFromRegistry } from './lib.mjs'

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) out[key] = true
      else {
        out[key] = next
        i++
      }
    } else out._.push(a)
  }
  return out
}

function die(msg) {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`)
  process.exit(1)
}
function ok(msg) {
  console.log(`\x1b[32m✓ ${msg}\x1b[0m`)
}

const args = parseArgs(process.argv.slice(2))
const stageDir = resolve(args.stage ?? process.env.UE_GALLERY_STAGE ?? '')
if (!args.stage && !process.env.UE_GALLERY_STAGE) die('缺少 --stage <stageDir>')
const target = args._[0]
if (!target) die('未指定要下架的扩展：<publisher>.<name>[@<version>]')

// 解析 <publisher>.<name>[@<version>]
const atIdx = target.lastIndexOf('@')
const idPart = atIdx > 0 ? target.slice(0, atIdx) : target
const version = atIdx > 0 ? target.slice(atIdx + 1) : undefined
const dot = idPart.indexOf('.')
if (dot <= 0) die(`扩展标识非法（应为 publisher.name）: ${idPart}`)
const publisher = idPart.slice(0, dot)
const name = idPart.slice(dot + 1)

const registry = readRegistry(stageDir)
const { removedAssetDirs, found } = removeFromRegistry(registry, publisher, name, version)
if (!found) die(`registry 中找不到 ${publisher}.${name}${version ? `@${version}` : ''}`)

writeRegistry(stageDir, registry)

for (const dir of removedAssetDirs) {
  const abs = resolve(stageDir, 'gallery', dir)
  if (existsSync(abs)) {
    rmSync(abs, { recursive: true, force: true })
    ok(`已删除本地资产 ${dir}`)
  }
}
ok(`已下架 ${publisher}.${name}${version ? `@${version}` : '（全部版本）'}`)
if (removedAssetDirs.length) {
  console.log(
    '\n⚠ upload 用 scp 增量同步，不会删除服务器上已存在的旧 assets 目录。如需彻底清理，到服务器手动删除：',
  )
  for (const dir of removedAssetDirs) console.log(`    <发布目录>/gallery/${dir}`)
}
