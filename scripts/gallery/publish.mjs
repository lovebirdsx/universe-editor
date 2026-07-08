#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  把一个或多个 .vsix 发布进本地 stage 的市场 registry。
 *
 *  用法（在仓库根目录）:
 *    node scripts/gallery/publish.mjs --stage <stageDir> a.vsix b.vsix ...
 *  或:  pnpm gallery:publish -- --stage <stageDir> a.vsix
 *
 *  产物落地到 <stageDir>/gallery/{registry.json, assets/<pub>.<name>/<version>/**}，随后用
 *  scripts/gallery/upload.mjs 同步到服务器（先 assets 后 registry.json，避免半态）。
 *  本脚本只写本地 stage，不碰服务器。
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import {
  readVsixManifest,
  readVsixEntry,
  metadataFromManifest,
  readRegistry,
  writeRegistry,
  upsertVersion,
} from './lib.mjs'

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
function warn(msg) {
  console.warn(`\x1b[33m⚠ ${msg}\x1b[0m`)
}

const args = parseArgs(process.argv.slice(2))
const stageDir = resolve(args.stage ?? process.env.UE_GALLERY_STAGE ?? '')
if (!args.stage && !process.env.UE_GALLERY_STAGE) die('缺少 --stage <stageDir>（市场 stage 目录）')
const vsixPaths = args._
if (vsixPaths.length === 0) die('未指定 .vsix 文件')

// ISO 时间；--now 覆盖（测试可注入固定值以确定性）。
const nowIso = args.now ?? new Date().toISOString()

const registry = readRegistry(stageDir)

for (const rawPath of vsixPaths) {
  const vsixPath = resolve(rawPath)
  if (!existsSync(vsixPath)) die(`找不到 VSIX: ${vsixPath}`)

  const manifest = readVsixManifest(vsixPath)
  const meta = metadataFromManifest(manifest)
  const id = `${meta.publisher}.${meta.name}`
  const assetDir = `assets/${id}/${meta.version}`
  const destDir = resolve(stageDir, 'gallery', assetDir)
  mkdirSync(destDir, { recursive: true })

  // VSIX 本体：以规范文件名落地。
  const vsixName = `${id}-${meta.version}.vsix`
  copyFileSync(vsixPath, resolve(destDir, vsixName))
  const files = { vsix: vsixName }

  // 图标：manifest.icon 指向 VSIX 内路径，抽出来落地。
  if (meta.iconRel) {
    const iconBuf = readVsixEntry(vsixPath, meta.iconRel)
    if (iconBuf) {
      const iconName = basename(meta.iconRel)
      writeFileSync(resolve(destDir, iconName), iconBuf)
      files.icon = iconName
    } else warn(`${id}: manifest.icon=${meta.iconRel} 在 VSIX 内不存在，跳过图标`)
  }

  // README / CHANGELOG：从 VSIX 内约定路径抽取（可选）。
  for (const [rel, key] of [
    ['README.md', 'readme'],
    ['CHANGELOG.md', 'changelog'],
  ]) {
    const buf = readVsixEntry(vsixPath, rel)
    if (buf) {
      writeFileSync(resolve(destDir, rel), buf)
      files[key] = rel
    }
  }

  const versionEntry = {
    version: meta.version,
    lastUpdated: nowIso,
    engine: meta.engine,
    assetDir,
    files,
  }

  const { warnings } = upsertVersion(registry, meta, versionEntry)
  for (const w of warnings) warn(w)
  ok(`已发布 ${id}@${meta.version} → ${assetDir}`)
}

writeRegistry(stageDir, registry)
ok(`registry.json 已更新（${registry.extensions.length} 个扩展）→ ${stageDir}/gallery/`)
console.log(
  `\n下一步：node scripts/gallery/upload.mjs --stage ${stageDir} --host <IP> --user <user> --dir <发布目录>`,
)
