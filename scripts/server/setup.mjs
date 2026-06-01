#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  把 server.mjs 部署成开机自启的系统服务，并管理其生命周期。
 *
 *  Ubuntu  → systemd unit   (/etc/systemd/system/universe-update-server.service)
 *  Windows → schtasks 计划任务 (UniverseUpdateServer, ONSTART, RU SYSTEM)
 *
 *  本脚本假定 node 已就绪（由 setup.sh / setup.ps1 负责装），自身只跑跨平台部署逻辑。
 *  需要管理员/root 权限运行（写系统服务、绑 80 端口、改防火墙）。
 *
 *  用法（一般经 setup.sh / setup.ps1 调用，也可直接跑）:
 *    sudo node scripts/server/setup.mjs install
 *    sudo node scripts/server/setup.mjs uninstall
 *    node scripts/server/setup.mjs status
 *
 *  可选参数（带默认）: --root <发布目录> --port <端口> --base <URL前缀>
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const isWin = process.platform === 'win32'

const SERVICE_NAME = 'universe-update-server'
const TASK_NAME = 'UniverseUpdateServer'

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

function info(msg) {
  console.log(`  ${msg}`)
}

// 跑外部命令，stdio 直通。check=true 时非零退出码即 die。
function run(cmd, cmdArgs, { check = true, ignoreFail = false } = {}) {
  const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit', shell: false })
  if (res.error) {
    if (ignoreFail) return res
    die(`执行失败: ${cmd} ${cmdArgs.join(' ')}\n  ${res.error.message}`)
  }
  if (check && res.status !== 0 && !ignoreFail) {
    die(`命令返回非零退出码 (${res.status}): ${cmd} ${cmdArgs.join(' ')}`)
  }
  return res
}

// 静默捕获输出（用于探测 node 路径）。
function capture(cmd, cmdArgs) {
  const res = spawnSync(cmd, cmdArgs, { encoding: 'utf8', shell: false })
  if (res.status !== 0) return null
  return (res.stdout ?? '').trim()
}

function resolveNodePath() {
  // 优先用当前进程的 node（最可靠）。process.execPath 即正在跑本脚本的 node。
  if (process.execPath && existsSync(process.execPath)) return process.execPath
  if (isWin) {
    const candidate = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe')
    if (existsSync(candidate)) return candidate
    const where = capture('where', ['node'])
    if (where) return where.split(/\r?\n/)[0].trim()
    die('找不到 node.exe，请先安装 Node.js')
  } else {
    const which = capture('which', ['node'])
    if (which) return which
    die('找不到 node，请先安装 Node.js')
  }
}

function platformDefaults() {
  if (isWin) {
    return {
      appDir: 'C:\\universe-editor\\app',
      root: 'C:\\universe-editor\\data',
      port: '80',
      base: '/universe-editor/',
    }
  }
  return {
    appDir: '/opt/universe-update-server',
    root: '/srv/universe-editor',
    port: '80',
    base: '/universe-editor/',
  }
}

function buildConfig(args) {
  const d = platformDefaults()
  return {
    appDir: args.appDir ?? d.appDir,
    root: resolve(args.root ?? d.root),
    port: String(args.port ?? d.port),
    base: args.base ?? d.base,
  }
}

// 把 server.mjs 拷到独立安装目录，让服务不依赖仓库存在。
function deployServer(appDir) {
  mkdirSync(appDir, { recursive: true })
  const dest = join(appDir, 'server.mjs')
  copyFileSync(join(__dirname, 'server.mjs'), dest)
  return dest
}

/*--------------------------------- Linux: systemd ---------------------------------*/

function unitPath() {
  return `/etc/systemd/system/${SERVICE_NAME}.service`
}

function installLinux(cfg) {
  if (process.getuid && process.getuid() !== 0) die('请用 sudo 运行（写 systemd unit 需 root）')

  const nodePath = resolveNodePath()
  const serverPath = deployServer(cfg.appDir)
  mkdirSync(cfg.root, { recursive: true })

  const unit = `[Unit]
Description=Universe Editor 更新分发静态服务器
After=network.target

[Service]
Type=simple
User=www-data
AmbientCapabilities=CAP_NET_BIND_SERVICE
ExecStart=${nodePath} ${serverPath} --root ${cfg.root} --port ${cfg.port} --base ${cfg.base}
Restart=always
RestartSec=2
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`
  writeFileSync(unitPath(), unit)
  info(`已写入 ${unitPath()}`)

  // 发布目录归 www-data 可读写（上传脚本用别的账号写，运行用 www-data 读）。
  run('chown', ['-R', 'www-data:www-data', cfg.root], { ignoreFail: true })

  run('systemctl', ['daemon-reload'])
  run('systemctl', ['enable', '--now', SERVICE_NAME])

  // 防火墙：ufw 存在才放行，否则跳过。
  if (capture('which', ['ufw'])) {
    run('ufw', ['allow', `${cfg.port}/tcp`], { ignoreFail: true })
  }

  ok(`systemd 服务 ${SERVICE_NAME} 已启动并设为开机自启`)
  info(`状态: systemctl status ${SERVICE_NAME}`)
  info(`日志: journalctl -u ${SERVICE_NAME} -f`)
  info(`发布目录: ${cfg.root}`)
}

function uninstallLinux(cfg) {
  if (process.getuid && process.getuid() !== 0) die('请用 sudo 运行')
  run('systemctl', ['disable', '--now', SERVICE_NAME], { ignoreFail: true })
  if (existsSync(unitPath())) {
    rmSync(unitPath())
    info(`已删除 ${unitPath()}`)
  }
  run('systemctl', ['daemon-reload'], { ignoreFail: true })
  if (existsSync(cfg.appDir)) rmSync(cfg.appDir, { recursive: true, force: true })
  ok(`已卸载 ${SERVICE_NAME}（发布目录 ${cfg.root} 保留）`)
}

function statusLinux() {
  run('systemctl', ['status', SERVICE_NAME], { check: false, ignoreFail: true })
}

/*--------------------------------- Windows: schtasks ---------------------------------*/

function installWin(cfg) {
  const nodePath = resolveNodePath()
  const serverPath = deployServer(cfg.appDir)
  mkdirSync(cfg.root, { recursive: true })

  // /TR 全绝对路径：任务以 SYSTEM 跑、cwd 是 system32、无用户 PATH。
  const tr = `"${nodePath}" "${serverPath}" --root "${cfg.root}" --port ${cfg.port} --base ${cfg.base}`
  run('schtasks', [
    '/Create',
    '/TN',
    TASK_NAME,
    '/SC',
    'ONSTART',
    '/RU',
    'SYSTEM',
    '/RL',
    'HIGHEST',
    '/TR',
    tr,
    '/F',
  ])
  info('计划任务已创建')

  // 防火墙放行（PowerShell New-NetFirewallRule，幂等：先删后建）。
  const fwName = `Universe Update Server (${cfg.port})`
  run(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Remove-NetFirewallRule -DisplayName '${fwName}' -ErrorAction SilentlyContinue; ` +
        `New-NetFirewallRule -DisplayName '${fwName}' -Direction Inbound -Protocol TCP -LocalPort ${cfg.port} -Action Allow | Out-Null`,
    ],
    { ignoreFail: true },
  )

  // 立即启动一次（否则要等下次开机）。
  run('schtasks', ['/Run', '/TN', TASK_NAME], { ignoreFail: true })

  ok(`计划任务 ${TASK_NAME} 已创建并启动，开机自动运行`)
  info(`查询: schtasks /Query /TN ${TASK_NAME}`)
  info(`发布目录: ${cfg.root}`)
}

function uninstallWin(cfg) {
  run('schtasks', ['/End', '/TN', TASK_NAME], { ignoreFail: true })
  run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { ignoreFail: true })
  const fwName = `Universe Update Server (${cfg.port})`
  run(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Remove-NetFirewallRule -DisplayName '${fwName}' -ErrorAction SilentlyContinue`,
    ],
    { ignoreFail: true },
  )
  if (existsSync(cfg.appDir)) rmSync(cfg.appDir, { recursive: true, force: true })
  ok(`已卸载 ${TASK_NAME}（发布目录 ${cfg.root} 保留）`)
}

function statusWin() {
  run('schtasks', ['/Query', '/TN', TASK_NAME, '/V', '/FO', 'LIST'], {
    check: false,
    ignoreFail: true,
  })
}

/*--------------------------------- 入口 ---------------------------------*/

const args = parseArgs(process.argv.slice(2))
const action = args._[0] ?? 'install'
const cfg = buildConfig(args)

console.log(`\n🔧 universe-update-server setup [${action}] (${process.platform})`)
console.log(`   appDir: ${cfg.appDir}`)
console.log(`   root:   ${cfg.root}`)
console.log(`   port:   ${cfg.port}  base: ${cfg.base}\n`)

switch (action) {
  case 'install':
    isWin ? installWin(cfg) : installLinux(cfg)
    break
  case 'uninstall':
    isWin ? uninstallWin(cfg) : uninstallLinux(cfg)
    break
  case 'status':
    isWin ? statusWin() : statusLinux()
    break
  default:
    die(`未知动作: ${action}（支持 install / uninstall / status）`)
}
