#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  远程首装：不登服务器，在本地控制台一条命令完成 universe-update-server 的首次安装
 *  （Ubuntu/systemd 与 Windows/计划任务均支持），以及 status/restart/uninstall 日常动作。
 *
 *  用法（在仓库根目录，显式 --env 护栏与 server:deploy 一致）:
 *    pnpm server:setup -- --env prod                 # 远程首装（默认 --action install）
 *    pnpm server:setup -- --env prod --action status # 远端 status / restart / uninstall
 *
 *  连接参数与 server:deploy 同一套（.env.<mode> / 环境变量 / 旗标三选一）:
 *    --host / --user / --port / --key      ← UE_RELEASE_HOST / USER / PORT / KEY
 *    --app-dir                             ← UE_SERVER_APP_DIR（默认识别出 Linux 路径）
 *    --health-url                          ← UE_SERVER_HEALTH_URL（默认 http://<host>/）
 *
 *  install 流程：本地 bundle → tar 打包（setup.mjs/setup.sh/setup.ps1/serverEnv.mjs +
 *  dist/server.js + dist/server.env）→ scp 上传 → 远端解包 → 提权执行首装 → 健康检查。
 *  提权密码在本地控制台输入：
 *    Ubuntu  本地星号回显读 sudo 密码，经 ssh 的 stdin 管道喂远端 sudo -S（不走 ssh -t——
 *            Windows OpenSSH 的 TTY 密码输入偶发不转发首次输入，远端 sudo 会一直卡在读
 *            密码）；远端已免密（sudo -n 通过）则自动跳过密码。顺带为该用户写
 *            /etc/sudoers.d/<service> 的 deploy 免密规则（--deploy-user 下传）。
 *    Windows Administrators 组成员的 ssh 会话自带提升令牌，无需 UAC；先探测 node，
 *            已有则直接 setup.mjs，缺失走 setup.ps1（winget 装 Node——ssh 非交互会话下
 *            经常不可用，失败时会提示先手动装一次 Node LTS）。
 *
 *  旗标:
 *    --dry-run       打印将执行的命令，零副作用
 *    --yes           跳过交互确认（脚本化场景；前置=host key 已信任、Linux sudo 免密或用 root）
 *    --force         远端已在运行（健康检查可达）时仍重跑首装：覆盖程序 / server.env /
 *                    启动器并重启服务；已生成的机密（签名私钥/管理令牌）不会覆盖
 *    --skip-bundle   复用已有 dist/server.js，跳过重新打包
 *
 *  远端形态按 --app-dir 是否为 Windows 路径自动识别（与 deploy 同一判定）。前置条件：
 *    Ubuntu  ssh 可达；登录用户可用 sudo（交互输密码）或直接用 root
 *    Windows 远端装好 OpenSSH Server 并自启、登录用户属 Administrators 组、
 *            默认 shell 为 cmd.exe（Windows 默认；执行前自动探测，非 cmd 立即报错
 *            并给修复指引），建议已装 Node LTS
 *  首次连接的 host-key 确认提示会直接出现在本地终端，照提示输入 yes 即可。
 *  详见 scripts/server/README.md 第一节「方式 B」。
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface as createPromptInterface } from 'node:readline/promises'
import { StringDecoder } from 'node:string_decoder'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { extractLocalVersion, extractRemoteVersion, isWindowsAppDir, parseArgs } from './deploy.mjs'
import {
  CMD_SHELL_FIX_HINT,
  CMD_SHELL_PROBE,
  buildSshArgs,
  isCmdExeShell,
  probeRemoteShellAnswer,
} from './remoteShell.mjs'
import { SERVER_ENV_FILE } from './serverEnv.mjs'
import { isValidDeployUser } from './setup.mjs'
import { loadEnv } from '../lib/env.mjs'

export { parseArgs }

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')
const serverDir = __dirname
const serverSource = join(serverDir, 'server.mjs')
const bundleOutput = join(serverDir, 'dist', 'server.js')
const stagedEnvOutput = join(serverDir, 'dist', SERVER_ENV_FILE)
const SERVICE_NAME = 'universe-update-server'
const TASK_NAME = 'UniverseUpdateServer'
const ACTIONS = ['install', 'status', 'restart', 'uninstall']

export function buildConfig(args, env) {
  const host = args.host ?? env.UE_RELEASE_HOST
  return {
    host,
    user: args.user ?? env.UE_RELEASE_USER,
    port: args.port ?? env.UE_RELEASE_PORT ?? '22',
    key: args.key ?? env.UE_RELEASE_KEY,
    appDir: args['app-dir'] ?? env.UE_SERVER_APP_DIR ?? '/opt/universe-update-server',
    healthUrl:
      args['health-url'] ?? env.UE_SERVER_HEALTH_URL ?? (host ? `http://${host}/` : undefined),
    action: typeof args.action === 'string' ? args.action : 'install',
    dryRun: args.dryRun ?? false,
    yes: args.yes ?? false,
    force: args.force ?? false,
    skipBundle: args.skipBundle ?? false,
  }
}

// tar 包内保持 setup.mjs 期望的目录形态（dist/server.js、dist/server.env、download-page/index.html
// 均按 __dirname 相对解析；下载页由 setup.mjs 落地到发布根）。server.env 是 bundle --env 的生成物，
// 不保证存在——存在才带，缺了远端用平台默认值。
export function buildTarFileList({ withEnv }) {
  const files = [
    'setup.mjs',
    'setup.sh',
    'setup.ps1',
    'serverEnv.mjs',
    'dist/server.js',
    'download-page/index.html',
  ]
  if (withEnv) files.push(`dist/${SERVER_ENV_FILE}`)
  return files
}

// Windows 远端默认 shell 是 cmd.exe，上行 tar 落在 cwd（%USERPROFILE%），相对引用即可。
// 每次先清残留再解包保证 staging 全新（重装/上次失败留下的旧文件会污染 setup）。
// Windows 绝不在 & 链里塞 if：cmd 会把 `& tar ...` 绑进 if 体，目录已存在时整条 tar 被静默跳过。
export function buildRemoteUnpackCommand({ staging, windows }) {
  if (windows)
    return (
      `rmdir /s /q ${staging} 2>nul & mkdir ${staging} && ` +
      `tar -xzf ${staging}.tgz -C ${staging} && echo unpacked`
    )
  return (
    `rm -rf ~/${staging} && mkdir -p ~/${staging} && ` +
    `tar -xzf ~/${staging}.tgz -C ~/${staging} && echo unpacked`
  )
}

// Linux 提权靠 sudo：useStdinPassword 时用 sudo -S 从 stdin 读密码（密码由本地经 ssh 管道喂入，
// 不走 TTY——Windows OpenSSH 的 TTY 密码输入偶发不转发首次输入）；否则直接 sudo（远端已免密/
// root，未免密时 sudo 因无 TTY 立即报错 fail-fast）。
// Windows 管理员 ssh 会话已是提升令牌，直接执行（有 node 跳 setup.ps1 省掉 winget）。
export function buildRemoteSetupCommand({
  appDir,
  deployUser,
  staging,
  windows,
  hasNode,
  useStdinPassword = false,
}) {
  if (windows) {
    const dir = appDir.replace(/\//g, '\\').replace(/[\\]+$/, '')
    const setupArgs = `install --app-dir "${dir}"`
    return hasNode
      ? `cd ${staging} && node setup.mjs ${setupArgs}`
      : `cd ${staging} && powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1 ${setupArgs}`
  }
  const deployFlag = deployUser ? ` --deploy-user '${deployUser}'` : ''
  // -S 从 stdin 读密码；-p '' 抑制远端重复的密码提示（本地已星号回显提示过一次），
  // 密码错误时 "Sorry, try again." 仍正常显示。
  const sudo = useStdinPassword ? "sudo -S -p ''" : 'sudo'
  return `cd ~/${staging} && ${sudo} bash setup.sh install --app-dir '${appDir}'${deployFlag}`
}

export function buildRemoteCleanupCommand({ staging, windows }) {
  if (windows) return `rmdir /s /q ${staging} 2>nul & del ${staging}.tgz 2>nul`
  return `rm -rf ~/${staging} ~/${staging}.tgz`
}

// status/restart/uninstall 不上传产物，直接用原生命令操作远端已安装的服务
// （安装目录里没有 setup.mjs，原生命令与 setup.mjs 对应动作行为一致）。
// Windows 防火墙规则按装机端口命名，卸载时 .env 里的端口未必与当初一致——用通配匹配。
// Linux 提权同 buildRemoteSetupCommand：useStdinPassword 时 sudo -S 从 stdin 读密码，
// uninstall 的多条 sudo 收进一个 bash -c（stdin 密码只喂得了一次）。
export function buildRemoteManageCommand({ action, appDir, windows, useStdinPassword = false }) {
  if (windows) {
    switch (action) {
      case 'status':
        return `schtasks /Query /TN ${TASK_NAME} /V /FO LIST`
      case 'restart':
        // /End 杀实例是异步的，紧跟 /Run 会撞旧实例未释放的端口，用 ping 垫 ~2s。
        return (
          `schtasks /End /TN ${TASK_NAME} 2>nul & ping -n 3 127.0.0.1 >nul & ` +
          `schtasks /Run /TN ${TASK_NAME}`
        )
      case 'uninstall': {
        const dir = appDir.replace(/\//g, '\\').replace(/[\\]+$/, '')
        return (
          `schtasks /End /TN ${TASK_NAME} 2>nul & schtasks /Delete /TN ${TASK_NAME} /F & ` +
          `powershell -NoProfile -Command "Remove-NetFirewallRule -DisplayName 'Universe Update Server*' -ErrorAction SilentlyContinue" & ` +
          `rmdir /s /q "${dir}" 2>nul`
        )
      }
    }
  } else {
    switch (action) {
      case 'status':
        return `systemctl status ${SERVICE_NAME}`
      case 'restart':
        return `${useStdinPassword ? "sudo -S -p ''" : 'sudo'} systemctl restart ${SERVICE_NAME}`
      case 'uninstall': {
        const sudo = useStdinPassword ? "sudo -S -p ''" : 'sudo'
        // appDir 已校验无单引号；单引号防 bash -c 内的 $ 展开，与旧多 sudo 版本同安全级别。
        return (
          `${sudo} bash -c "systemctl disable --now ${SERVICE_NAME}; ` +
          `rm -f /etc/systemd/system/${SERVICE_NAME}.service; ` +
          `systemctl daemon-reload; rm -rf '${appDir}'"`
        )
      }
    }
  }
  return null
}

function die(msg) {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`)
  process.exit(1)
}

function warn(msg) {
  console.warn(`\x1b[33m⚠ ${msg}\x1b[0m`)
}

// 交互终端读密码（星号回显、不回显明文）：raw 模式逐键拼装，回车结束。
// 密码经 ssh 的 stdin 管道喂远端 sudo -S——不走 ssh -t（Windows OpenSSH 的 TTY 密码输入
// 偶发不转发首次输入，远端 sudo 会一直卡在读密码且本地无任何输出，见 remoteShell.mjs）。
// 不用 readline 的 terminal 模式：Interface 会自己回显每个输入字符（行编辑功能），
// 与控制台 echo 一起把明文混进星号（k*u*r*o*）——这里直接 setRawMode + data 事件，
// 屏幕回显全由本函数写。raw 下 Ctrl+C 是字符（）不是信号，退出前必须恢复回显。
function readSecret(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin
    const decoder = new StringDecoder('utf8')
    const prevRaw = stdin.isRaw
    let secret = ''
    let done = false
    const cleanup = () => {
      stdin.removeListener('data', onData)
      process.removeListener('SIGINT', onSigint)
      if (!prevRaw && stdin.isRaw) stdin.setRawMode(false)
      // resume 过的 TTY 读句柄会撑住事件循环：必须 pause 回退，否则主流程结束后进程挂起
      stdin.pause()
    }
    const finish = () => {
      if (done) return
      done = true
      cleanup()
      process.stdout.write('\n')
      resolve(secret)
    }
    const onData = (chunk) => {
      for (const ch of decoder.write(chunk)) {
        if (ch === '\r' || ch === '\n') return finish()
        if (ch === '\x03') {
          cleanup()
          process.stdout.write('\n')
          process.exit(130)
        }
        if (ch === '\x04') return finish() // Ctrl+D：按空密码结束（sudo 会自行报错）
        if (ch === '\b' || ch === '\x7f') {
          if (secret) {
            secret = secret.slice(0, -1)
            process.stdout.write('\b \b')
          }
        } else if (ch >= ' ') {
          secret += ch
          process.stdout.write('*')
        }
      }
    }
    const onSigint = () => {
      cleanup()
      process.stdout.write('\n')
      process.exit(130)
    }
    process.once('SIGINT', onSigint)
    stdin.resume()
    stdin.setRawMode(true)
    process.stdout.write(prompt)
    stdin.on('data', onData)
  })
}

async function fetchVersion(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    return extractRemoteVersion(await res.text())
  } catch {
    return null
  }
}

// 健康轮询：版本匹配即成功；拿不到版本（连接失败）静默重试，拿到不一致版本经 onMismatch 报告。
// fetchImpl 注入便于单测；返回是否达标。
export async function pollRemoteVersion({
  fetchImpl,
  healthUrl,
  localVersion,
  attempts = 10,
  sleepMs = 1000,
  onMismatch,
}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const v = await fetchImpl(healthUrl)
    if (v === localVersion) return true
    if (v !== null && onMismatch) onMismatch(v, attempt)
    if (sleepMs > 0) await sleep(sleepMs)
  }
  return false
}

// 健康验证超时的 die 消息：服务地址 + 按平台给排障路径。
// Windows 侧高发根因是「服务启动即崩，报错被 run.cmd 的 >nul 2>&1 吞掉」
// （LastTaskResult 非 0 且 State 回到 Ready），指引手动跑启动器看真实报错。
export function buildHealthTimeoutMessage({ healthUrl, localVersion, windows, remote, appDir }) {
  const lines = [`健康验证超时：${healthUrl} 未返回 v${localVersion}。`]
  if (windows) {
    const dir = appDir.replace(/\//g, '\\').replace(/[\\]+$/, '')
    lines.push(
      `  上服务器查看任务状态：ssh ${remote} "schtasks /Query /TN ${TASK_NAME} /V /FO LIST"`,
    )
    lines.push(
      `  若 State=Ready 且 LastTaskResult 非 0（启动即崩）：登服务器把 ${dir}\\run.cmd 里 ` +
        'node 命令行尾的 >nul 2>&1 临时去掉，手动执行 run.cmd 即可看到启动报错（修完恢复重定向）。',
    )
  } else {
    lines.push(`  上服务器看日志：ssh ${remote} journalctl -u ${SERVICE_NAME} -n 50`)
  }
  return lines.join('\n')
}

async function main() {
  const { mode, explicit } = loadEnv()
  if (!explicit) {
    die(
      '远程首装必须显式指定目标环境：pnpm server:setup -- --env prod（生产）或 --env test（测试机），或设 UE_ENV\n' +
        '  连接参数从对应 .env.<mode> 读取，见 .env.example',
    )
  }

  const args = parseArgs(process.argv.slice(2))
  const config = buildConfig(args, process.env)

  if (!ACTIONS.includes(config.action)) {
    die(`未知 --action "${config.action}"（支持 ${ACTIONS.join(' / ')}）`)
  }
  if (!config.host) die(`缺少 --host（或 UE_RELEASE_HOST，可放 .env.${mode}）`)
  if (!config.user) die(`缺少 --user（或 UE_RELEASE_USER，可放 .env.${mode}）`)

  const isWindowsTarget = isWindowsAppDir(config.appDir)
  // Windows 上行落到 %USERPROFILE%，Linux 落到 ~；两端都用相对引用。
  const staging = `ue-server-setup-v${extractLocalVersion(readFileSync(serverSource, 'utf8'))}`

  // appDir 会进高风险远端命令（uninstall 的 rm -rf / rmdir）——拒根目录与盘符根，防删穿。
  const trimmedAppDir = config.appDir.replace(/[\\/]+$/, '')
  if (trimmedAppDir === '' || trimmedAppDir === '/' || /^[A-Za-z]:$/.test(trimmedAppDir)) {
    die(`appDir 过于宽泛，拒绝执行: "${config.appDir}"`)
  }
  // Linux 远端命令过 sh 且 appDir 用单引号包裹——值里带单引号会破坏配对，直接拒。
  if (!isWindowsTarget && config.appDir.includes("'")) {
    die(`appDir 含单引号，无法安全拼远端 sh 命令: "${config.appDir}"`)
  }

  const remote = `${config.user}@${config.host}`
  const sshBase = ['-p', config.port]
  const scpBase = ['-P', config.port]
  if (config.key) {
    sshBase.push('-i', config.key)
    scpBase.push('-i', config.key)
  }

  // 远端单步挂死不能无输出死等（Win32-OpenSSH 非交互挂起的前科），每步给墙钟上限。
  const TIMEOUT_MS = {
    bundle: 600_000,
    tar: 60_000,
    scp: 300_000,
    probe: 15_000,
    manage: 60_000,
    unpack: 180_000,
    install: 900_000,
    cleanup: 60_000,
  }

  function run(cmd, cmdArgs, opts = {}) {
    const printable = `${cmd} ${cmdArgs.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`
    if (config.dryRun) {
      console.log(`  [dry-run] ${printable}`)
      return
    }
    const spawnOpts = {
      stdio: opts.input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
      input: opts.input,
      timeout: opts.timeoutMs,
      ...opts.spawnOpts,
    }
    // shell:true + args 数组触发 node DEP0190 弃用警告（args 只拼接不转义）——Windows 上
    // pnpm 是 .cmd shim 必须经 shell，改传拼好的单命令字符串（printable 已对含空格参数
    // 加引号；参数均为脚本内定值，无外部输入）。
    const res = spawnOpts.shell
      ? spawnSync(printable, spawnOpts)
      : spawnSync(cmd, cmdArgs, spawnOpts)
    if (res.error?.code === 'ETIMEDOUT') {
      die(
        `命令超时（${Math.round((opts.timeoutMs ?? 0) / 1000)}s 无返回）: ${printable}${opts.hint ?? ''}`,
      )
    }
    if (res.error) die(`执行失败: ${printable}\n  ${res.error.message}`)
    if (res.status === null) die(`命令被信号终止 (${res.signal}): ${printable}${opts.hint ?? ''}`)
    if (res.status !== 0) {
      if (opts.tolerant) {
        warn(`命令返回非零退出码 (${res.status})，已继续: ${printable}`)
        return
      }
      die(`命令返回非零退出码 (${res.status}): ${printable}${opts.hint ?? ''}`)
    }
  }

  // tty=true 时加 -t 分配远端 TTY；stdinPipe=true 时不加 -t/-n（stdin 管道喂远端 sudo -S，
  // 密码经管道可靠传输），加 BatchMode=yes 让 ssh 层交互 fail-fast；否则 -n（stdin=nul），
  // 规避 Win32-OpenSSH 非交互挂起，见 remoteShell.mjs 文件头。
  function sshRemote(cmdStr, opts = {}) {
    run(
      'ssh',
      buildSshArgs({
        baseArgs: sshBase,
        remote,
        command: cmdStr,
        tty: opts.tty,
        stdinPipe: opts.stdinPipe,
      }),
      opts,
    )
  }

  // 登录探测（node 是否就绪），不应答视为缺失。
  function probeRemote(cmdStr, timeoutMs = TIMEOUT_MS.probe) {
    const res = spawnSync('ssh', buildSshArgs({ baseArgs: sshBase, remote, command: cmdStr }), {
      encoding: 'utf8',
      timeout: timeoutMs,
    })
    if (res.error || res.status !== 0) return null
    return (res.stdout ?? '').trim()
  }

  // Windows 远端命令全是 cmd 语法（带引号的路径在 cmd/PowerShell 间无安全写法，不做
  // 兼容封装，见 remoteShell.mjs 文件头）——远端默认 shell 非 cmd 在此就 fail-fast。
  function assertRemoteCmdShell() {
    if (config.dryRun) {
      console.log(`  [dry-run] ssh ${remote} "${CMD_SHELL_PROBE}"   # 探测远端默认 shell`)
      return
    }
    const answer = probeRemoteShellAnswer({ baseArgs: sshBase, remote })
    if (isCmdExeShell(answer)) return
    if (answer !== null) {
      die(
        `远端 OpenSSH 默认 shell 不是 cmd.exe（${CMD_SHELL_PROBE} 回显: "${answer}"）\n  ${CMD_SHELL_FIX_HINT}`,
      )
    }
    warn(
      `远端默认 shell 探测未应答（ssh 失败？），仍按 cmd 语法执行——解析失败请先检查 DefaultShell`,
    )
  }

  async function confirm(prompt) {
    if (!process.stdin.isTTY) die('非交互终端下必须加 --yes（或先用 --dry-run 检查）')
    const rl = createPromptInterface({ input: process.stdin, output: process.stdout })
    const answer = (await rl.question(prompt)).trim().toLowerCase()
    rl.close()
    if (answer !== 'y' && answer !== 'yes') die('已取消')
  }

  // Linux 提权的 sudo 密码：远端已免密直接跳过；交互终端本地读密码（星号回显，经 ssh
  // stdin 管道喂 sudo -S——不走 -t，见 remoteShell.mjs）；非交互终端无法读密码，要求
  // 远端已免密/root（否则远端 sudo 因无 TTY 立即报错）。dry-run 不读密码，按 TTY 与否
  // 返回占位串决定打印 -S 形态，保证与真实执行一致。
  // 免密探测用与目标命令同形态的无副作用命令（sudoers 只认精确命令匹配）：
  //   install/uninstall 探测 `sudo -n bash -c true`——只有全免密（ALL NOPASSWD）才跳过，
  //   命令特定的 deploy 规则不覆盖 setup.sh / bash -c，仍读密码喂 sudo -S；
  //   restart 探测 `sudo -n /usr/bin/true`——deploy 规则含该锚点（buildDeploySudoers），
  //   规则在 ⇒ restart 亦在规则内 ⇒ 免密跳过。
  async function resolveSudoPassword(remote, probeCmd) {
    if (!process.stdin.isTTY) {
      warn('非交互终端：不读 sudo 密码，远端 sudo 须已免密（或改用 root 登录）')
      return null
    }
    if (config.dryRun) return '<password>'
    if (probeRemote(`sudo -n ${probeCmd}`) !== null) {
      console.log('  远端 sudo 已免密，无需输入密码')
      return null
    }
    return readSecret(`远端 sudo 密码（${remote}，不回显）: `)
  }

  if (config.action !== 'install') {
    console.log(
      `\n🔧 [${mode}] 远端 ${config.action} → ${remote}（${isWindowsTarget ? 'Windows/计划任务' : 'Ubuntu/systemd'}）`,
    )
    if (config.action === 'uninstall' && !config.dryRun && !config.yes) {
      await confirm(`确认卸载 ${remote} 上的服务（删除服务与安装目录，发布目录保留）? [y/N] `)
    }
    if (isWindowsTarget) assertRemoteCmdShell()
    // Linux restart/uninstall 需提权：本地读密码经 ssh stdin 喂远端 sudo -S（已免密则跳过）。
    const needsSudo = !isWindowsTarget && config.action !== 'status'
    const password = needsSudo
      ? await resolveSudoPassword(
          remote,
          config.action === 'restart' ? '/usr/bin/true' : 'bash -c true',
        )
      : null
    const cmdStr = buildRemoteManageCommand({
      action: config.action,
      appDir: config.appDir,
      windows: isWindowsTarget,
      useStdinPassword: password !== null,
    })
    // systemctl status 不接 TTY（避免 pager 阻塞）；提权用 stdinPipe（密码经管道喂 sudo -S）。
    sshRemote(cmdStr, {
      stdinPipe: password !== null,
      input: password === null ? undefined : `${password}\n`,
      tolerant: config.action !== 'restart',
      timeoutMs: TIMEOUT_MS.manage,
    })
    if (!config.dryRun && config.action !== 'status') {
      console.log(`\x1b[32m✓ 远端 ${config.action} 完成\x1b[0m`)
    }
    return
  }

  /*--------------------------------- install ---------------------------------*/

  const localVersion = extractLocalVersion(readFileSync(serverSource, 'utf8'))
  if (!localVersion) die(`无法从 ${serverSource} 读到 SERVER_VERSION——确认该常量声明未被改动`)

  console.log(`\n🔍 探测远端是否已安装 ${config.healthUrl}`)
  const remoteVersion = await fetchVersion(config.healthUrl)
  if (remoteVersion !== null) {
    const advice = `日常更新程序/配置请改用 pnpm server:deploy -- --env ${mode}`
    if (!config.force && !config.dryRun) {
      die(
        `远端已在运行 v${remoteVersion}。${advice}\n` +
          '  确认要重跑首装请加 --force：覆盖程序、server.env 与启动器并重启服务；' +
          '已生成的机密（签名私钥/管理令牌）不会覆盖',
      )
    }
    warn(
      `远端已在运行 v${remoteVersion}。--force 生效：程序、server.env 与启动器将被覆盖并重启服务；` +
        `已生成的机密保留。${advice}`,
    )
  }

  console.log(
    `\n🚀 [${mode}] 远程首装 ${SERVICE_NAME} v${localVersion} → ${remote}:${config.appDir}` +
      `（${isWindowsTarget ? 'Windows/计划任务' : 'Ubuntu/systemd'}）`,
  )
  if (isWindowsTarget) assertRemoteCmdShell()
  if (config.dryRun) console.log('   (dry-run，不实际执行)\n')
  if (!config.dryRun && !config.yes) await confirm('继续远程首装? [y/N] ')

  if (config.skipBundle) {
    if (!existsSync(bundleOutput))
      die(`--skip-bundle 但找不到 ${bundleOutput}，先跑 pnpm server:bundle`)
    console.log('⏭️  跳过打包，复用已有 dist/server.js')
  } else {
    console.log('📦 打包 dist/server.js + dist/server.env')
    // 透传 --env：bundle 按同一 mode 生成 dist/server.env，随包上服务器，首装即带配置。
    run('pnpm', ['server:bundle', '--', '--env', mode], {
      timeoutMs: TIMEOUT_MS.bundle,
      spawnOpts: { cwd: repoRoot, shell: process.platform === 'win32' },
    })
  }

  const withEnv = existsSync(stagedEnvOutput)
  if (!withEnv) {
    warn(`未找到 dist/${SERVER_ENV_FILE}——远端将用平台默认值（或安装目录已有配置）`)
  }

  console.log('🗜️  打包首装产物')
  const tgzLocal = join(tmpdir(), `${staging}.tgz`)
  run('tar', ['-czf', tgzLocal, '-C', serverDir, ...buildTarFileList({ withEnv })], {
    timeoutMs: TIMEOUT_MS.tar,
  })

  const remoteTgz = isWindowsTarget ? `${staging}.tgz` : `~/${staging}.tgz`
  console.log(`⬆️  上传 ${staging}.tgz → ${remote}:${remoteTgz}`)
  run('scp', [...scpBase, tgzLocal, `${remote}:${remoteTgz}`], { timeoutMs: TIMEOUT_MS.scp })
  if (!config.dryRun) {
    try {
      unlinkSync(tgzLocal)
    } catch {
      /* 本地临时包清理失败无碍 */
    }
  }

  console.log('📂 远端解包')
  sshRemote(buildRemoteUnpackCommand({ staging, windows: isWindowsTarget }), {
    timeoutMs: TIMEOUT_MS.unpack,
    hint: '\n  远端解包失败：确认远端装有 tar（Windows 10+ 自带 bsdtar）且上载目录可写',
  })

  console.log(
    `🔧 提权执行首装${isWindowsTarget ? '' : '（密码本地输入 → ssh stdin → 远端 sudo -S）'}`,
  )
  if (isWindowsTarget) {
    // winget 在 ssh 非交互会话下经常不可用——有 node 就走 setup.mjs 直装，绕开装 Node 步骤。
    let hasNode = true
    if (config.dryRun) {
      console.log(`  [dry-run] ssh ${remote} "node --version"   # 探测远端 Node，二选一执行下条`)
    } else {
      const nodeVersion = probeRemote('node --version')
      hasNode = nodeVersion !== null
      console.log(
        hasNode
          ? `  远端 Node 已就绪 (${nodeVersion})，直接 node setup.mjs`
          : '  远端未检测到 Node，改走 setup.ps1（winget 装 Node）',
      )
    }
    sshRemote(
      buildRemoteSetupCommand({
        appDir: config.appDir,
        staging,
        windows: true,
        hasNode,
      }),
      {
        timeoutMs: TIMEOUT_MS.install,
        hint:
          '\n  Windows 首装失败排查：\n' +
          '    1) ssh 登录用户需属 Administrators 组（OpenSSH 默认发放提升令牌）\n' +
          '    2) ssh 非交互会话下 winget 经常不可用——请先在服务器上装一次 Node LTS，再重跑本命令',
      },
    )
  } else {
    // sudoers 写入要求合法 Linux 用户名（换行注入可伪造授权），不合规则跳过该步保持其余流程。
    const deployUser = isValidDeployUser(config.user) ? config.user : null
    if (!deployUser) {
      warn(`ssh 用户名 "${config.user}" 不是合法 Linux 用户名，跳过自动写 deploy sudoers`)
    }
    const password = await resolveSudoPassword(remote, 'bash -c true')
    sshRemote(
      buildRemoteSetupCommand({
        appDir: config.appDir,
        deployUser,
        staging,
        windows: false,
        useStdinPassword: password !== null,
      }),
      {
        stdinPipe: password !== null,
        input: password === null ? undefined : `${password}\n`,
        timeoutMs: TIMEOUT_MS.install,
        hint: '\n  sudo 提权失败：确认 ssh 用户有 sudo 权限（或改用 root 登录）；密码输错直接重跑本命令',
      },
    )
  }

  sshRemote(buildRemoteCleanupCommand({ staging, windows: isWindowsTarget }), {
    tolerant: true,
    timeoutMs: TIMEOUT_MS.cleanup,
  })

  if (config.dryRun) {
    console.log(
      `\n\x1b[2m[dry-run] 健康验证将轮询 ${config.healthUrl} 断言 v${localVersion}\x1b[0m\n`,
    )
    return
  }

  console.log(`🩺 健康验证 ${config.healthUrl}`)
  const healthy = await pollRemoteVersion({
    fetchImpl: fetchVersion,
    healthUrl: config.healthUrl,
    localVersion,
    onMismatch: (v, attempt) =>
      warn(`第 ${attempt} 次探测返回 v${v}（期望 v${localVersion}），等待服务启动…`),
  })
  if (healthy) {
    console.log(`\n\x1b[32m✓ 首装完成，服务已健康运行 v${localVersion}\x1b[0m`)
    console.log(`   服务地址: ${config.healthUrl}（更新端点在 <base> 前缀下）`)
    console.log('')
    console.log('\x1b[33m━━━ 首装收尾 ━━━\x1b[0m')
    console.log(
      '上方输出里的「市场签名公钥」必须内置进客户端，否则从本市场装扩展会被 fail-closed 拒装：\n' +
        '  1) 编辑 apps/editor/src/main/services/extensionManagement/marketplaceSigningKeys.ts\n' +
        '     往 BUILTIN_MARKETPLACE_SIGNING_KEYS 加一行（保留已有条目，勿删旧 keyId）\n' +
        '  2) 重新打包发版——旧客户端升级到含该公钥的版本后才能装本市场扩展\n' +
        '临时联调可用 UNIVERSE_GALLERY_SIGNING_KEYS 环境变量；' +
        '审批管理令牌明文同样只打印一次，注意保存。详见 scripts/server/README.md「让客户端信任签名公钥」。',
    )
    console.log('')
    return
  }
  die(
    buildHealthTimeoutMessage({
      healthUrl: config.healthUrl,
      localVersion,
      windows: isWindowsTarget,
      remote,
      appDir: config.appDir,
    }),
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
