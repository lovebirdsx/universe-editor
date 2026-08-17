#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  把 SDK 五件套打包成 npm tarball 并落地 <stage>/gallery/sdk/，供拉不到公网 npm 的内网
 *  环境经市场服务器静态托管安装：
 *
 *    npm i <base>gallery/sdk/universe-editor-extension-api-0.7.0.tgz
 *
 *  用法（在仓库根目录）:
 *    node scripts/gallery/publish-sdk.mjs --stage <stageDir>
 *  或:  pnpm gallery:publish-sdk -- --stage <stageDir>
 *
 *  本脚本只写本地 stage，不碰服务器；随后与扩展市场同一入口上传（sdk/** 随之同步）:
 *    node scripts/gallery/upload.mjs --stage <stageDir> --host <IP> --user deploy --dir <市场根>
 *
 *  <stage>/gallery/sdk/ 由本脚本独占管理：每次运行先清空再重新 pack，保证不残留旧版本。
 *  pnpm pack 与 pnpm publish 共用同一套打包逻辑（workspace:/catalog: 协议会被替换为
 *  真实版本号），故产出的 tarball 与 npm 上发布的包内容一致。
 *  发布集合清单见 scripts/lib/sdk-packages.mjs（与 ext-packages/publish.mjs 共用）。
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { repoRoot } from './lib.mjs'
import { SDK_PACKAGE_DIRS } from '../lib/sdk-packages.mjs'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) out[key] = true
      else {
        out[key] = next
        i++
      }
    }
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
if (!args.stage && !process.env.UE_GALLERY_STAGE) die('缺少 --stage <stageDir>（市场 stage 目录）')
const dryRun = args.dryRun ?? false

const sdkDir = join(stageDir, 'gallery', 'sdk')

console.log(`\n📦 SDK tarball → ${sdkDir}${dryRun ? '（dry-run）' : ''}`)

if (!dryRun) {
  rmSync(sdkDir, { recursive: true, force: true })
  mkdirSync(sdkDir, { recursive: true })
}

const produced = []
for (const rel of SDK_PACKAGE_DIRS) {
  const pkgDir = resolve(repoRoot, rel)
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  console.log(`\n▸ ${pkg.name}@${pkg.version}`)
  const res = spawnSync('pnpm', ['pack', '--pack-destination', sdkDir], {
    cwd: pkgDir,
    stdio: dryRun ? 'pipe' : 'inherit',
    shell: process.platform === 'win32',
  })
  if (dryRun) {
    produced.push(`universe-editor-${pkg.name.split('/')[1]}-${pkg.version}.tgz`)
    continue
  }
  if (res.error || res.status !== 0) die(`pnpm pack 失败: ${pkg.name} (${res.error?.message ?? `exit ${res.status}`})`)
}

if (!dryRun) {
  const tarballs = readdirSync(sdkDir).filter((f) => f.endsWith('.tgz'))
  if (tarballs.length !== SDK_PACKAGE_DIRS.length)
    die(`产物数量不符：期望 ${SDK_PACKAGE_DIRS.length} 个 tarball，实际 ${tarballs.length} 个 (${tarballs.join(', ')})`)
  for (const f of tarballs.sort()) console.log(`   ${f}`)
  ok(`${tarballs.length} 个 SDK tarball 就绪。内网安装：`)
  console.log(`   npm i <市场地址>gallery/sdk/${tarballs.sort()[0]}`)
  console.log(`\n下一步：node scripts/gallery/upload.mjs --stage ${stageDir} --host <IP> --user <user> --dir <市场根>`)
} else {
  for (const f of produced) console.log(`   [dry-run] 将产出 ${f}`)
  ok('dry-run 完成')
}
