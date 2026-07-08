#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  把本地 stage 的市场内容同步到静态服务器的**市场根**（server 的 --gallery-root 指向同一处）。
 *
 *  用法（在仓库根目录）:
 *    node scripts/gallery/upload.mjs --stage <stageDir> --host <IP> --user deploy --dir <市场根>
 *  或用环境变量: UE_RELEASE_HOST / UE_RELEASE_USER（与 release/upload.mjs 共用连接信息）
 *              UE_GALLERY_DIR（市场根，与更新目录 UE_RELEASE_DIR 解耦）。
 *
 *  --dir 是服务器上的**市场根**，与 server 的 --gallery-root 一致：
 *    - 合并部署（市场是更新目录子树）：--dir /srv/universe-editor/gallery
 *    - 独立部署（市场单独一处）：      --dir /srv/extensions
 *  本脚本把 registry.json / control.json / assets/** 直接同步到该根下，不再硬拼 gallery/ 子段。
 *
 *  底层用系统自带 ssh / scp（无第三方依赖）。
 *  顺序红线：先传 assets/**（VSIX 落地），最后覆盖 registry.json；否则客户端会读到
 *  「清单说有、包还没到」的半态。control.json 若存在一并同步。
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'

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
function warn(msg) {
  console.warn(`\x1b[33m⚠ ${msg}\x1b[0m`)
}

const args = parseArgs(process.argv.slice(2))
const config = {
  stage: resolve(args.stage ?? process.env.UE_GALLERY_STAGE ?? ''),
  host: args.host ?? process.env.UE_RELEASE_HOST,
  user: args.user ?? process.env.UE_RELEASE_USER,
  // 市场根（服务器 --gallery-root）。与更新目录 UE_RELEASE_DIR 解耦，用独立的 UE_GALLERY_DIR。
  dir: args.dir ?? process.env.UE_GALLERY_DIR,
  port: args.port ?? process.env.UE_RELEASE_PORT ?? '22',
  key: args.key ?? process.env.UE_RELEASE_KEY,
  remoteOs: args['remote-os'] ?? process.env.UE_RELEASE_OS,
  dryRun: args.dryRun ?? false,
}

if (!args.stage && !process.env.UE_GALLERY_STAGE) die('缺少 --stage <stageDir>')
if (!config.host) die('缺少 --host（或 UE_RELEASE_HOST）')
if (!config.user) die('缺少 --user（或 UE_RELEASE_USER）')
if (!config.dir)
  die('缺少 --dir（或 UE_GALLERY_DIR），即服务器上的市场根（server 的 --gallery-root）')

const galleryDir = join(config.stage, 'gallery')
if (!existsSync(galleryDir))
  die(`找不到市场子树: ${galleryDir}\n  先跑 scripts/gallery/publish.mjs`)
const registryFile = join(galleryDir, 'registry.json')
if (!existsSync(registryFile)) die(`找不到 ${registryFile}；先发布至少一个扩展`)

config.dir = config.dir.replace(/[\\/]+$/, '')
const isWindowsTarget =
  config.remoteOs === 'windows' ||
  (config.remoteOs !== 'linux' && (/^[A-Za-z]:[\\/]/.test(config.dir) || config.dir.includes('\\')))

const sep = isWindowsTarget ? '\\' : '/'
const remote = `${config.user}@${config.host}`
const sshBase = ['-p', config.port]
const scpBase = ['-P', config.port]
if (config.key) {
  sshBase.push('-i', config.key)
  scpBase.push('-i', config.key)
}

// 递归收集 assets/** 文件（相对 galleryDir 的 posix 路径）。
function walk(dir, acc) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) walk(abs, acc)
    else acc.push(abs)
  }
  return acc
}

const assetsDir = join(galleryDir, 'assets')
const assetFiles = existsSync(assetsDir) ? walk(assetsDir, []) : []
const controlFile = join(galleryDir, 'control.json')

// --dir 就是市场根，直接拼接（不再插入 gallery/ 子段）。
function remotePath(...segs) {
  return [config.dir, ...segs].join(sep)
}
function remoteDirOf(relPosix) {
  const parts = relPosix.split('/')
  parts.pop()
  return remotePath(...parts)
}

function run(cmd, cmdArgs, opts = {}) {
  const printable = `${cmd} ${cmdArgs.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`
  if (config.dryRun) {
    console.log(`  [dry-run] ${printable}`)
    return
  }
  const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit' })
  if (res.error) {
    if (opts.warnOnly) return warn(`执行失败: ${printable}\n  ${res.error.message}`)
    die(`执行失败: ${printable}\n  ${res.error.message}`)
  }
  if (res.status !== 0) {
    if (opts.warnOnly) return warn(`命令返回非零退出码 (${res.status}): ${printable}`)
    die(`命令返回非零退出码 (${res.status}): ${printable}`)
  }
}

function mkdirRemote(remoteDir) {
  const cmd = isWindowsTarget
    ? `cmd /c if not exist "${remoteDir}" md "${remoteDir}"`
    : `mkdir -p '${remoteDir}'`
  run('ssh', [...sshBase, remote, cmd], { warnOnly: true })
}

console.log(`\n📦 市场内容 → ${remote}:${config.dir}`)
console.log(
  `   assets: ${assetFiles.length} 个文件${existsSync(controlFile) ? ' + control.json' : ''} + registry.json`,
)
if (config.dryRun) console.log('   (dry-run，不实际上传)\n')
else console.log('')

// 1) 先建目录并传 assets/**（registry 引用的包必须先落地）。
const madeDirs = new Set()
for (const abs of assetFiles) {
  const relPosix = relative(galleryDir, abs).split(/[\\/]/).join('/')
  const rDir = remoteDirOf(relPosix)
  if (!madeDirs.has(rDir)) {
    mkdirRemote(rDir)
    madeDirs.add(rDir)
  }
  console.log(`⬆️  ${relPosix}`)
  run('scp', [...scpBase, abs, `${remote}:${rDir}${sep}`])
}

// 2) control.json（可选，恶意/弃用清单）。
if (existsSync(controlFile)) {
  mkdirRemote(remotePath())
  console.log('⬆️  control.json')
  run('scp', [...scpBase, controlFile, `${remote}:${remotePath()}${sep}`])
}

// 3) 最后覆盖 registry.json（清单最后落地，避免半态）。
mkdirRemote(remotePath())
console.log('⬆️  registry.json')
run('scp', [...scpBase, registryFile, `${remote}:${remotePath()}${sep}`])

console.log(
  `\n\x1b[32m✓ 完成。客户端下次搜索即从 ${config.dir}/registry.json 读到最新市场\x1b[0m\n`,
)
