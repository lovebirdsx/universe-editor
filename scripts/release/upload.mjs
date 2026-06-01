#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  把 apps/editor/release/ 下的更新产物同步到内网静态服务器。
 *
 *  用法（在仓库根目录）:
 *    node scripts/release/upload.mjs --host 10.0.0.5 --user deploy --dir /srv/universe-editor
 *  或用环境变量:
 *    UE_RELEASE_HOST=10.0.0.5 UE_RELEASE_USER=deploy UE_RELEASE_DIR=/srv/universe-editor \
 *      node scripts/release/upload.mjs
 *
 *  底层用系统自带的 ssh / scp（Windows 10+ 与 Ubuntu 均内置 OpenSSH），无第三方依赖。
 *
 *  关键顺序: 先传 .exe / .blockmap，最后传 latest.yml。latest.yml 是 autoUpdater
 *  读取的清单，必须等安装包完整落地后再覆盖，否则客户端会拉到半包。
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')
const releaseDir = join(repoRoot, 'apps', 'editor', 'release')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--no-mkdir') out.mkdir = false
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

const args = parseArgs(process.argv.slice(2))

const config = {
  host: args.host ?? process.env.UE_RELEASE_HOST,
  user: args.user ?? process.env.UE_RELEASE_USER,
  dir: args.dir ?? process.env.UE_RELEASE_DIR,
  port: args.port ?? process.env.UE_RELEASE_PORT ?? '22',
  key: args.key ?? process.env.UE_RELEASE_KEY,
  dryRun: args.dryRun ?? false,
  mkdir: args.mkdir ?? true,
}

function die(msg) {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`)
  process.exit(1)
}

if (!config.host) die('缺少 --host（或 UE_RELEASE_HOST）')
if (!config.user) die('缺少 --user（或 UE_RELEASE_USER）')
if (!config.dir) die('缺少 --dir（或 UE_RELEASE_DIR），即服务器上的目标目录')
if (!existsSync(releaseDir)) die(`找不到产物目录: ${releaseDir}\n  先跑 pnpm --filter @universe-editor/editor package:win`)

// 收集要上传的文件。latest.yml 排最后。
const entries = readdirSync(releaseDir)
const payloads = entries.filter((f) => f.endsWith('.exe') || f.endsWith('.blockmap'))
const manifests = entries.filter((f) => f === 'latest.yml')

if (manifests.length === 0) die('release/ 下没有 latest.yml；确认 electron-builder.yml 已配 publish 且打包成功')
if (payloads.length === 0) die('release/ 下没有 .exe / .blockmap 产物')

// 从 latest.yml 读出版本号，仅用于日志展示。
let version = '?'
try {
  const m = readFileSync(join(releaseDir, 'latest.yml'), 'utf8').match(/^version:\s*(.+)$/m)
  if (m) version = m[1].trim()
} catch {
  /* 版本号只用于打印，读不到不致命 */
}

const remote = `${config.user}@${config.host}`
const sshBase = ['-p', config.port]
const scpBase = ['-P', config.port]
if (config.key) {
  sshBase.push('-i', config.key)
  scpBase.push('-i', config.key)
}

function run(cmd, cmdArgs) {
  const printable = `${cmd} ${cmdArgs.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`
  if (config.dryRun) {
    console.log(`  [dry-run] ${printable}`)
    return
  }
  const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit' })
  if (res.error) die(`执行失败: ${printable}\n  ${res.error.message}`)
  if (res.status !== 0) die(`命令返回非零退出码 (${res.status}): ${printable}`)
}

console.log(`\n📦 Universe Editor ${version} → ${remote}:${config.dir}`)
console.log(`   产物: ${payloads.join(', ')} + latest.yml`)
if (config.dryRun) console.log('   (dry-run，不实际上传)\n')
else console.log('')

if (config.mkdir) {
  run('ssh', [...sshBase, remote, `mkdir -p '${config.dir}'`])
}

// 先 payload 后 manifest：scp 目标为目录时用源文件名落地，文件名空格无需转义。
for (const file of [...payloads, ...manifests]) {
  console.log(`⬆️  ${file}`)
  run('scp', [...scpBase, join(releaseDir, file), `${remote}:${config.dir}/`])
}

console.log(`\n\x1b[32m✓ 完成。客户端将在下次检查时从 ${config.dir}/latest.yml 发现 ${version}\x1b[0m\n`)
