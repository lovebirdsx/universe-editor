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
  remoteOs: args['remote-os'] ?? process.env.UE_RELEASE_OS,
  dryRun: args.dryRun ?? false,
  mkdir: args.mkdir ?? true,
}

function die(msg) {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`)
  process.exit(1)
}

function warn(msg) {
  console.warn(`\x1b[33m⚠ ${msg}\x1b[0m`)
}

if (!config.host) die('缺少 --host（或 UE_RELEASE_HOST）')
if (!config.user) die('缺少 --user（或 UE_RELEASE_USER）')
if (!config.dir) die('缺少 --dir（或 UE_RELEASE_DIR），即服务器上的目标目录')
if (!existsSync(releaseDir))
  die(`找不到产物目录: ${releaseDir}\n  先跑 pnpm --filter @universe-editor/editor package:win`)

// 去掉尾部分隔符，避免拼出 D:\universe-editor\/ 这种脏路径。
config.dir = config.dir.replace(/[\\/]+$/, '')

// 远端是 Windows 还是类 Unix：决定 mkdir 用什么命令。盘符开头或含反斜杠即判为 Windows。
const isWindowsTarget =
  config.remoteOs === 'windows' ||
  (config.remoteOs !== 'linux' && (/^[A-Za-z]:[\\/]/.test(config.dir) || config.dir.includes('\\')))

// 收集要上传的文件。autoUpdater 清单 latest.yml 必须等安装包落地后再覆盖，故排最后。
// 下载页 index.html 与更新日志 release-notes.json 不在 release/ 下，用各自的源路径一并同步。
const entries = readdirSync(releaseDir)
const payloads = entries.filter((f) => f.endsWith('.exe') || f.endsWith('.blockmap'))
const manifests = entries.filter((f) => f === 'latest.yml')

if (manifests.length === 0)
  die('release/ 下没有 latest.yml；确认 electron-builder.yml 已配 publish 且打包成功')
if (payloads.length === 0) die('release/ 下没有 .exe / .blockmap 产物')

const downloadPage = join(repoRoot, 'scripts', 'server', 'download-page', 'index.html')
const releaseNotes = join(repoRoot, 'apps', 'editor', 'resources', 'release-notes.json')

// 上传清单（{ label 仅用于日志, src 本地源路径 }），顺序即上传顺序：
// 先 payload，再静态下载页，最后清单类（latest.yml + release-notes.json）。
const uploads = payloads.map((f) => ({ label: f, src: join(releaseDir, f) }))
if (existsSync(downloadPage)) uploads.push({ label: 'index.html', src: downloadPage })
else warn(`找不到下载页 ${downloadPage}，跳过同步`)
uploads.push(...manifests.map((f) => ({ label: f, src: join(releaseDir, f) })))
if (existsSync(releaseNotes)) uploads.push({ label: 'release-notes.json', src: releaseNotes })
else warn(`找不到 ${releaseNotes}，跳过同步（下载页将不展示更新日志）`)

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

console.log(`\n📦 Universe Editor ${version} → ${remote}:${config.dir}`)
console.log(`   产物: ${uploads.map((u) => u.label).join(', ')}`)
if (config.dryRun) console.log('   (dry-run，不实际上传)\n')
else console.log('')

if (config.mkdir) {
  // Windows 远端用 cmd /c 包裹：无论默认 shell 是 cmd 还是 PowerShell 都能跑，if not exist 保证幂等。
  // mkdir 失败仅告警不退出，避免“目录已存在”等无害情形阻断上传。
  const mkdirCmd = isWindowsTarget
    ? `cmd /c if not exist "${config.dir}" md "${config.dir}"`
    : `mkdir -p '${config.dir}'`
  run('ssh', [...sshBase, remote, mkdirCmd], { warnOnly: true })
}

// 上传前预检：用临时探针文件确认目标目录可写。否则要等 scp 半路 Permission denied
// 才暴露权限问题，错误信息既晚又不直观（目录通常是 root 建的，user 进得去写不了）。
if (!config.dryRun) {
  const probe = isWindowsTarget ? `${config.dir}\\.ue-write-probe` : `${config.dir}/.ue-write-probe`
  const probeCmd = isWindowsTarget
    ? `cmd /c type nul > "${probe}" && del "${probe}"`
    : `touch '${probe}' && rm -f '${probe}'`
  const res = spawnSync('ssh', [...sshBase, remote, probeCmd], { encoding: 'utf8' })
  if (res.error) die(`无法连接 ${remote}：${res.error.message}`)
  if (res.status !== 0) {
    const detail = (res.stderr || '').trim()
    die(
      `目标目录不可写：${config.user} 对 ${config.dir} 没有写权限。\n` +
        (detail ? `  服务器返回: ${detail}\n` : '') +
        `  在服务器上用 root/sudo 执行其一后重试：\n` +
        `    sudo chown -R ${config.user} ${config.dir}\n` +
        `    sudo chmod -R 0775 ${config.dir}\n` +
        `  或改用 ${config.user} 有写权限的目录（--dir）。`,
    )
  }
}

// 先 payload 后 manifest：scp 目标为目录时用源文件名落地，文件名空格无需转义。
for (const item of uploads) {
  console.log(`⬆️  ${item.label}`)
  run('scp', [...scpBase, item.src, `${remote}:${config.dir}/`])
}

console.log(
  `\n\x1b[32m✓ 完成。客户端将在下次检查时从 ${config.dir}/latest.yml 发现 ${version}\x1b[0m\n`,
)
