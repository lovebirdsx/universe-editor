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
 *    sudo node scripts/server/setup.mjs restart
 *
 *  配置来源（优先级 高→低）: CLI 旗标 > server.env > 平台默认值。
 *    server.env 优先读同目录（deploy 上传的那份随包），其次读安装目录已有的那份；
 *    install 会把最终配置写回 <appDir>/server.env，由服务定义注入进程环境
 *    （systemd EnvironmentFile / Windows run.cmd 逐行 set），server.mjs 认 UE_SERVER_*。
 *    ⇒ 日常改配置只需改开发机 .env.<mode> 后重新 deploy，不必登服务器重装。
 *
 *  可选参数（覆盖 server.env，写回文件；键名见 serverEnv.mjs 的 SERVER_ENV_KEYS）:
 *    --root <发布目录> --port <端口> --base <URL前缀> --gallery-root --auth-dir
 *    --signing-key-file <pem> --signing-key-id <id> --admin-token-file <path> --register-rate-limit <n>
 *    --env-file <path>  显式指定 server.env 位置
 *  install 时签名私钥 / 管理令牌文件不存在会自动生成（私钥 0600 + 打印公钥内置指引）。
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { SERVER_ENV_FILE, buildServerEnv, parseEnvText, serializeServerEnv } from './serverEnv.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const isWin = process.platform === 'win32'

const SERVICE_NAME = 'universe-update-server'
const TASK_NAME = 'UniverseUpdateServer'

export function parseArgs(argv) {
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

// CLI 旗标 → UE_SERVER_* 键。给了才参与覆盖（没给的保持 server.env / 默认值）。
const FLAG_TO_ENV_KEY = {
  root: 'UE_SERVER_ROOT',
  'gallery-root': 'UE_SERVER_GALLERY_ROOT',
  'auth-dir': 'UE_SERVER_AUTH_DIR',
  port: 'UE_SERVER_PORT',
  host: 'UE_SERVER_HOST',
  base: 'UE_SERVER_BASE',
  'max-vsix-size': 'UE_SERVER_MAX_VSIX_SIZE',
  'register-rate-limit': 'UE_SERVER_REGISTER_RATE_LIMIT',
  'signing-key-file': 'UE_SERVER_SIGNING_KEY_FILE',
  'signing-key-id': 'UE_SERVER_SIGNING_KEY_ID',
  'admin-token-file': 'UE_SERVER_ADMIN_TOKEN_FILE',
}

// server.env 查找顺序：--env-file > 同目录（deploy 随包上传的那份）> 安装目录已有的那份。
// 前两者是"这次要装的配置"，最后一个让不带参数重跑 install 不丢已有配置。
export function resolveEnvOverrides(args, appDirGuess) {
  const candidates = []
  if (typeof args['env-file'] === 'string') candidates.push(resolve(args['env-file']))
  candidates.push(join(__dirname, SERVER_ENV_FILE))
  if (appDirGuess) candidates.push(join(appDirGuess, SERVER_ENV_FILE))
  for (const file of candidates) {
    if (!existsSync(file)) continue
    return { file, values: parseEnvText(readFileSync(file, 'utf8')) }
  }
  return { file: null, values: {} }
}

export function buildConfig(args) {
  const defaultAppDir = isWin ? 'C:\\universe-editor\\app' : '/opt/universe-update-server'
  const appDir = args['app-dir'] ?? defaultAppDir
  const { file: envFile, values: overrides } = resolveEnvOverrides(args, appDir)

  const flags = {}
  for (const [flag, key] of Object.entries(FLAG_TO_ENV_KEY)) {
    if (args[flag] !== undefined && args[flag] !== true) flags[key] = String(args[flag])
  }

  const env = buildServerEnv({ windows: isWin, overrides, flags })
  // 路径立即 resolve——服务运行时 cwd 不是当前目录（systemd 默认 /、计划任务是 system32），
  // 相对路径必失效。写回 server.env 的也是绝对路径。
  for (const key of [
    'UE_SERVER_ROOT',
    'UE_SERVER_GALLERY_ROOT',
    'UE_SERVER_AUTH_DIR',
    'UE_SERVER_SIGNING_KEY_FILE',
    'UE_SERVER_ADMIN_TOKEN_FILE',
  ]) {
    if (env[key]) env[key] = resolve(env[key])
  }

  return {
    appDir: resolve(appDir),
    envFile,
    env,
    root: env.UE_SERVER_ROOT,
    galleryRoot: env.UE_SERVER_GALLERY_ROOT,
    authDir: env.UE_SERVER_AUTH_DIR,
    port: env.UE_SERVER_PORT,
    base: env.UE_SERVER_BASE,
    signingKeyFile: env.UE_SERVER_SIGNING_KEY_FILE,
    signingKeyId: env.UE_SERVER_SIGNING_KEY_ID,
    adminTokenFile: env.UE_SERVER_ADMIN_TOKEN_FILE,
  }
}

/*--------------------------------- 机密文件自动生成 ---------------------------------*/

// 签名私钥缺失则生成，并打印公钥内置指引——客户端只信任内置表里的 keyId，
// 不把公钥加进 marketplaceSigningKeys.ts 并发版，装扩展会 fail-closed 拒装。
function ensureSigningKey(cfg) {
  if (existsSync(cfg.signingKeyFile)) {
    info(`签名私钥已存在: ${cfg.signingKeyFile}`)
    return null
  }
  mkdirSync(dirname(cfg.signingKeyFile), { recursive: true })
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  writeFileSync(cfg.signingKeyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), {
    mode: 0o600,
  })
  if (!isWin) chmodSync(cfg.signingKeyFile, 0o600)
  ok(`已生成市场签名私钥 ${cfg.signingKeyFile}（0600，勿外传、勿进仓库）`)
  return publicKey.export({ format: 'jwk' }).x
}

function ensureAdminToken(cfg) {
  if (existsSync(cfg.adminTokenFile)) {
    info(`管理令牌已存在: ${cfg.adminTokenFile}`)
    return null
  }
  mkdirSync(dirname(cfg.adminTokenFile), { recursive: true })
  const token = randomBytes(32).toString('base64')
  writeFileSync(cfg.adminTokenFile, token, { mode: 0o600 })
  if (!isWin) chmodSync(cfg.adminTokenFile, 0o600)
  ok(`已生成审批管理令牌 ${cfg.adminTokenFile}（0600）`)
  return token
}

// 装完打印一次性信息：公钥（必须内置进客户端才能装扩展）与管理令牌明文。
function printSecretsSummary(cfg, { publicKeyX, adminToken, baseUrlHint }) {
  if (!publicKeyX && !adminToken) return
  console.log('')
  console.log('\x1b[33m━━━ 请立即记录以下一次性信息 ━━━\x1b[0m')
  if (publicKeyX) {
    console.log(`
\x1b[1m市场签名公钥（keyId ${cfg.signingKeyId}）:\x1b[0m
  ${publicKeyX}

必须让客户端信任它，否则从本市场装扩展会因验签失败被拒（fail-closed）。二选一：

  1) 正式发布（推荐）：在仓库里编辑
       apps/editor/src/main/services/extensionManagement/marketplaceSigningKeys.ts
     往 BUILTIN_MARKETPLACE_SIGNING_KEYS 加一行（保留已有条目，勿删旧 keyId）：
       '${cfg.signingKeyId}': '${publicKeyX}',
     然后重新打包发版；旧客户端要升级到含该公钥的版本后才能装本市场的扩展。

  2) 临时联调 / 内部试用：客户端启动前设环境变量
       UNIVERSE_GALLERY_SIGNING_KEYS={"${cfg.signingKeyId}":"${publicKeyX}"}
     （叠加在内置表之上，仅适合 dev/e2e，不作为长期方案）`)
  }
  if (adminToken) {
    console.log(`
\x1b[1m审批管理令牌（明文仅此一次）:\x1b[0m
  ${adminToken}

  管理页 ${baseUrlHint}gallery/admin 登录用；文件已存 ${cfg.adminTokenFile}`)
  }
  console.log('')
}

// 把打包产物（单文件，publish API 依赖已内联）拷到独立安装目录，让服务不依赖仓库存在。
// dist/server.js 由仓库侧 `pnpm server:bundle` 生成——部署方须先把 scripts/server/ 整目录
// （含 dist/）带到服务器，服务器上没有 node_modules 可解析 adm-zip/zod。
function deployServer(appDir) {
  const bundled = join(__dirname, 'dist', 'server.js')
  if (!existsSync(bundled)) {
    die(
      `缺少打包产物 ${bundled}\n` +
        '  发布流程: 在仓库内跑 pnpm server:bundle，再把 scripts/server/ 整目录拷到服务器执行本脚本',
    )
  }
  mkdirSync(appDir, { recursive: true })
  const dest = join(appDir, 'server.mjs')
  copyFileSync(bundled, dest)
  return dest
}

/*--------------------------------- 服务定义文本 ---------------------------------*/

// 配置全走 EnvironmentFile（server.mjs 认 UE_SERVER_*），ExecStart 不带任何配置旗标——
// 改端口/路径只需重写 server.env 再 restart，无需 daemon-reload 改 unit。
export function buildSystemdUnit({ nodePath, serverPath, envFile }) {
  return `[Unit]
Description=Universe Editor 更新分发静态服务器
After=network.target

[Service]
Type=simple
User=www-data
AmbientCapabilities=CAP_NET_BIND_SERVICE
EnvironmentFile=${envFile}
ExecStart=${nodePath} ${serverPath}
Restart=always
RestartSec=2
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`
}

// schtasks /TR 有 261 字符上限，完整命令行放进启动器 run.cmd，任务只指向它。
// 不用 `start`（会脱离任务的 job object，/End 就杀不干净子进程）。
// >nul 2>&1 必须有：Task Scheduler 下 cmd 传给 node 的 stdout 句柄无效，node 一写
// 启动横幅就 EBADF 崩（退出码 1）；不重定向到文件是因为 server 有每请求访问日志，
// 长跑必无界增长。排查启动失败时手动跑本文件即可看到输出。
// 配置走 server.env：for /f 逐行读成环境变量，等价于 systemd 的 EnvironmentFile。
// eol=# 跳过注释行；delims== + tokens=1* 保证值里的 = 与空格（如 base64 令牌）不被截断。
export function buildWindowsLauncher({ nodePath, serverPath, envFile }) {
  return (
    [
      '@echo off',
      'setlocal',
      `for /f "usebackq eol=# tokens=1* delims==" %%a in ("${envFile}") do if not "%%a"=="" set "%%a=%%b"`,
      `"${nodePath}" "${serverPath}" >nul 2>&1`,
    ].join('\r\n') + '\r\n'
  )
}

// 把最终配置写进 <appDir>/server.env，服务定义只引用它——改配置不必改服务定义。
function writeServerEnvFile(cfg) {
  const dest = join(cfg.appDir, SERVER_ENV_FILE)
  writeFileSync(dest, serializeServerEnv(cfg.env, { windows: isWin }))
  info(`已写入运行时配置 ${dest}`)
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
  mkdirSync(cfg.galleryRoot, { recursive: true })
  mkdirSync(cfg.authDir, { recursive: true })

  const publicKeyX = ensureSigningKey(cfg)
  const adminToken = ensureAdminToken(cfg)
  const envFile = writeServerEnvFile(cfg)

  // 配置全走 EnvironmentFile（server.mjs 认 UE_SERVER_*），ExecStart 保持不变——
  // 改端口/路径只需重写 server.env 再 restart，无需 daemon-reload 改 unit。
  writeFileSync(unitPath(), buildSystemdUnit({ nodePath, serverPath, envFile }))
  info(`已写入 ${unitPath()}`)

  // 发布目录 + 市场根 + 认证目录归 www-data 可读写（上传脚本用别的账号写，运行用 www-data 读；
  // publish API 运行时还要写 galleryRoot 的资产与 registry）。
  run('chown', ['-R', 'www-data:www-data', cfg.root], { ignoreFail: true })
  if (!cfg.galleryRoot.startsWith(cfg.root + '/')) {
    run('chown', ['-R', 'www-data:www-data', cfg.galleryRoot], { ignoreFail: true })
  }
  if (!cfg.authDir.startsWith(cfg.root + '/')) {
    run('chown', ['-R', 'www-data:www-data', cfg.authDir], { ignoreFail: true })
  }
  // 机密文件可能被指到 authDir 之外，逐个归属——服务以 www-data 跑，读不到就启动失败。
  for (const secret of [cfg.signingKeyFile, cfg.adminTokenFile]) {
    if (existsSync(secret)) run('chown', ['www-data:www-data', secret], { ignoreFail: true })
  }

  run('systemctl', ['daemon-reload'])
  run('systemctl', ['enable', '--now', SERVICE_NAME])
  // enable --now 不重启已在跑的服务，重跑 install 改了配置也要生效。
  run('systemctl', ['restart', SERVICE_NAME], { ignoreFail: true })

  // 防火墙：ufw 存在才放行，否则跳过。
  if (capture('which', ['ufw'])) {
    run('ufw', ['allow', `${cfg.port}/tcp`], { ignoreFail: true })
  }

  ok(`systemd 服务 ${SERVICE_NAME} 已启动并设为开机自启`)
  info(`状态: systemctl status ${SERVICE_NAME}`)
  info(`日志: journalctl -u ${SERVICE_NAME} -f`)
  info(`发布目录: ${cfg.root}`)
  printSecretsSummary(cfg, {
    publicKeyX,
    adminToken,
    baseUrlHint: `http://<服务器IP>${cfg.base}`,
  })
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

function restartLinux() {
  if (process.getuid && process.getuid() !== 0) die('请用 sudo 运行')
  run('systemctl', ['restart', SERVICE_NAME])
  ok(`已重启 ${SERVICE_NAME}`)
}

/*--------------------------------- Windows: schtasks ---------------------------------*/

function installWin(cfg) {
  const nodePath = resolveNodePath()
  const serverPath = deployServer(cfg.appDir)
  mkdirSync(cfg.root, { recursive: true })
  mkdirSync(cfg.galleryRoot, { recursive: true })
  mkdirSync(cfg.authDir, { recursive: true })

  const publicKeyX = ensureSigningKey(cfg)
  const adminToken = ensureAdminToken(cfg)
  const envFile = writeServerEnvFile(cfg)

  const launcher = join(cfg.appDir, 'run.cmd')
  writeFileSync(launcher, buildWindowsLauncher({ nodePath, serverPath, envFile }))
  info(`已写入启动器 ${launcher}`)
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
    `"${launcher}"`,
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

  // 立即启动一次（否则要等下次开机）。旧实例可能还在跑（/Create /F 不停进程），
  // 先 End 等停再 Run，避免新实例撞端口。
  run('schtasks', ['/End', '/TN', TASK_NAME], { ignoreFail: true })
  waitForTaskEnd()
  run('schtasks', ['/Run', '/TN', TASK_NAME], { ignoreFail: true })

  ok(`计划任务 ${TASK_NAME} 已创建并启动，开机自动运行`)
  info(`查询: schtasks /Query /TN ${TASK_NAME}`)
  info(`发布目录: ${cfg.root}`)
  printSecretsSummary(cfg, {
    publicKeyX,
    adminToken,
    baseUrlHint: `http://<服务器IP>${cfg.base}`,
  })
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

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// /End 杀实例是异步的：立刻 /Run 会撞上旧实例尚未释放的端口（EADDRINUSE 退出码 1）。
// 用 PowerShell 读 State（枚举名不随系统语言变），轮询等到不再 Running。
function waitForTaskEnd() {
  for (let i = 0; i < 20; i++) {
    const state = capture('powershell', [
      '-NoProfile',
      '-Command',
      `(Get-ScheduledTask -TaskName ${TASK_NAME}).State`,
    ])
    if (state !== 'Running') return
    sleepMs(500)
  }
  console.warn(`\x1b[33m⚠ 等待 ${TASK_NAME} 停止超时，仍尝试启动（可能撞端口占用）\x1b[0m`)
}

function restartWin() {
  run('schtasks', ['/End', '/TN', TASK_NAME], { ignoreFail: true })
  waitForTaskEnd()
  run('schtasks', ['/Run', '/TN', TASK_NAME])
  ok(`已重启 ${TASK_NAME}`)
}

/*--------------------------------- 入口 ---------------------------------*/

// 被测试 import 时不执行入口逻辑（buildConfig / resolveEnvOverrides 需可单测）。
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2))
  const action = args._[0] ?? 'install'
  const cfg = buildConfig(args)

  console.log(`\n🔧 universe-update-server setup [${action}] (${process.platform})`)
  console.log(`   appDir:      ${cfg.appDir}`)
  console.log(`   config:      ${cfg.envFile ?? '（无 server.env，用平台默认值）'}`)
  console.log(`   root:        ${cfg.root}`)
  console.log(`   galleryRoot: ${cfg.galleryRoot}`)
  console.log(`   authDir:     ${cfg.authDir}`)
  console.log(`   port:        ${cfg.port}  base: ${cfg.base}`)
  console.log(`   signingKey:  ${cfg.signingKeyFile} (keyId ${cfg.signingKeyId})`)
  console.log(`   adminToken:  ${cfg.adminTokenFile}`)
  console.log('')

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
    case 'restart':
      isWin ? restartWin() : restartLinux()
      break
    default:
      die(`未知动作: ${action}（支持 install / uninstall / status / restart）`)
  }
}
