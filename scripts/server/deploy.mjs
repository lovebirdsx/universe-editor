#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  一条指令发布更新服务器：bundle → 上传 → 远端安装 → 重启 → 健康验证。
 *
 *  用法（在仓库根目录，必须显式指定目标环境——防误发护栏）:
 *    pnpm server:deploy -- --env prod    # 生产机
 *    pnpm server:deploy -- --env test    # 测试机（预验证）
 *  或:
 *    UE_ENV=prod pnpm server:deploy
 *
 *  连接参数与 release:upload 同一套（.env.<mode> / 环境变量 / 旗标三选一，见 .env.example）:
 *    --host / --user / --port / --key      ← UE_RELEASE_HOST / USER / PORT / KEY
 *    --app-dir                             ← UE_SERVER_APP_DIR（默认 /opt/universe-update-server）
 *    --health-url                          ← UE_SERVER_HEALTH_URL（默认 http://<host>/）
 *
 *  服务端运行时配置（UE_SERVER_ROOT / PORT / BASE / SIGNING_KEY_FILE …，白名单见 serverEnv.mjs）
 *  也从 .env.<mode> 读取，每次部署生成 server.env 一并上传到 <app-dir>，服务重启即生效——
 *  改服务器参数只需改 .env.<mode> 后重跑本命令，不必登服务器重装。
 *
 *  下载页 scripts/server/download-page/index.html 也随本命令同步到 <UE_SERVER_ROOT>/index.html
 *  （发布目录数据，与安装目录解耦；改下载页 UI 记得给 SERVER_VERSION +1，否则远端拦下）。
 *  --skip-env 跳过的只是 server.env，这条路不受影响（UE_SERVER_ROOT 改从远端 server.env 读）。
 *
 *  旗标:
 *    --dry-run       打印将执行的命令与版本比对，零副作用
 *    --yes           跳过交互确认（脚本化场景）
 *    --force         远端版本 >= 本地时仍强制部署（默认拦下，提醒 bump SERVER_VERSION）
 *    --skip-bundle   复用已有 dist/server.js，跳过重新打包
 *    --skip-env      不上传 server.env（只换程序与下载页，完全保留服务器上现有配置）
 *
 *  远端支持两种形态（按 --app-dir 是否为 Windows 路径自动识别）:
 *    Ubuntu/systemd   前置条件=部署用户免密 sudo（缺失时打印精确 sudoers 配置后退出）
 *  远端支持两种形态（按 --app-dir 是否为 Windows 路径自动识别）:
 *    Ubuntu/systemd   前置条件=部署用户免密 sudo（缺失时打印精确 sudoers 配置后退出）
 *    Windows/计划任务  前置条件=远端装好 OpenSSH Server、ssh 用户属 Administrators、
 *                     默认 shell 为 cmd.exe（Windows 默认；执行前自动探测，非 cmd 立即
 *                     报错并给修复指引），且已用 setup.ps1 完成首次安装
 *  详见 scripts/server/README.md 第六节。
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { loadEnv } from '../lib/env.mjs'
import {
  CMD_SHELL_FIX_HINT,
  CMD_SHELL_PROBE,
  buildSshArgs,
  isCmdExeShell,
  probeRemoteShellAnswer,
} from './remoteShell.mjs'
import {
  SERVER_ENV_FILE,
  buildDeploySudoers,
  isWindowsPath,
  parseEnvText,
  renderServerEnv,
  serverEnvPath,
} from './serverEnv.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')
const serverSource = join(__dirname, 'server.mjs')
const downloadPageSource = join(__dirname, 'download-page', 'index.html')
const bundleOutput = join(__dirname, 'dist', 'server.js')
const stagedEnvOutput = join(__dirname, 'dist', SERVER_ENV_FILE)
const SERVICE_NAME = 'universe-update-server'
const TASK_NAME = 'UniverseUpdateServer'

// 远端单步挂死不能无输出死等（Win32-OpenSSH 非交互挂起的前科），每步给墙钟上限。
const TIMEOUT_MS = {
  bundle: 600_000,
  scp: 300_000,
  remote: 300_000,
  probe: 15_000,
}

export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--yes') out.yes = true
    else if (a === '--force') out.force = true
    else if (a === '--skip-bundle') out.skipBundle = true
    else if (a === '--skip-env') out.skipEnv = true
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
    dryRun: args.dryRun ?? false,
    yes: args.yes ?? false,
    force: args.force ?? false,
    skipBundle: args.skipBundle ?? false,
    skipEnv: args.skipEnv ?? false,
  }
}

export function extractLocalVersion(sourceText) {
  const m = sourceText.match(/^const SERVER_VERSION = '(\d+)'/m)
  return m ? m[1] : null
}

export function extractRemoteVersion(bodyText) {
  const m = bodyText.match(/universe-update-server v(\d+) ok/)
  return m ? m[1] : null
}

// 返回 { needsForce, message }：== 疑似忘 bump，> 疑似降级，均需 --force；不可达仅警告。
export function assessVersions(localVersion, remoteVersion) {
  if (remoteVersion === null) {
    return { needsForce: false, message: '远端版本不可达（可能是首次部署或服务未运行），跳过比对' }
  }
  const local = Number(localVersion)
  const remote = Number(remoteVersion)
  if (remote === local) {
    return {
      needsForce: true,
      message: `远端已是 v${remote}，与本地相同——疑似忘了给 server.mjs 的 SERVER_VERSION +1`,
    }
  }
  if (remote > local) {
    return {
      needsForce: true,
      message: `远端 v${remote} 比本地 v${localVersion} 新——疑似降级部署`,
    }
  }
  return { needsForce: false, message: `远端 v${remote} → 本地 v${localVersion}` }
}

// Windows 远端的识别依据：--app-dir / UE_SERVER_APP_DIR 是 Windows 路径（盘符或反斜杠）。
// 与 bundle 共用同一判定（serverEnv.mjs），避免两条路对同一 .env 得出不同目标平台。
export const isWindowsAppDir = isWindowsPath

// Linux: cp 成功才 restart，最后清理临时文件；sudo -n 保证非交互失败可确定诊断。
// Windows: copy 成功才 End+Run（copy 失败不动在跑的服务；End 在未运行时失败无害，静默），
//   Run 成功才清理。End 杀实例是异步的，紧跟 /Run 会撞旧实例未释放的端口，用 ping 垫 ~2s
//   （timeout /t 在 ssh 的重定向 stdin 下会报错）。staged 文件走 scp 相对路径落在
//   %USERPROFILE%，ssh 命令 cwd 亦在此，相对引用即可；目标路径归一成反斜杠（cmd 的 copy
//   会把正斜杠当开关）。假定远端默认 shell 为 cmd.exe（Windows OpenSSH 默认）。
// withEnv=true 时先落 server.env 再落 server.mjs——配置比程序先到，重启后一次性生效。
// index.html（下载页）落 <serverRoot>/index.html：它是发布目录数据（来自 server.env 的
// UE_SERVER_ROOT，判定走 isWindowsPath），不在 sudo 覆盖的安装目录内。
export function buildRemoteInstallCommand({
  appDir,
  serverRoot,
  version,
  windows = false,
  withEnv = false,
}) {
  if (windows) {
    const staged = `server.js.v${version}`
    const stagedEnv = `${SERVER_ENV_FILE}.v${version}`
    const stagedPage = `index.html.v${version}`
    const dir = appDir.replace(/\//g, '\\').replace(/[\\]+$/, '')
    const rootDir = isWindowsPath(serverRoot)
      ? serverRoot.replace(/\//g, '\\').replace(/[\\]+$/, '')
      : serverRoot
    const envStep = withEnv
      ? `copy /Y ${stagedEnv} "${dir}\\${SERVER_ENV_FILE}" && del ${stagedEnv} && `
      : ''
    return (
      `${envStep}copy /Y ${stagedPage} "${rootDir}\\index.html" && del ${stagedPage} && ` +
      `copy /Y ${staged} "${dir}\\server.mjs" && ` +
      `(schtasks /End /TN ${TASK_NAME} 2>nul & ping -n 3 127.0.0.1 >nul & ` +
      `schtasks /Run /TN ${TASK_NAME}) && del ${staged}`
    )
  }
  const staged = `~/server.js.v${version}`
  const stagedEnv = `~/${SERVER_ENV_FILE}.v${version}`
  const stagedPage = `~/index.html.v${version}`
  const envStep = withEnv
    ? `sudo -n cp ${stagedEnv} ${appDir}/${SERVER_ENV_FILE} && rm ${stagedEnv} && `
    : ''
  return (
    `${envStep}sudo -n cp ${stagedPage} ${serverRoot}/index.html && rm ${stagedPage} && ` +
    `sudo -n cp ${staged} ${appDir}/server.mjs && ` +
    `sudo -n systemctl restart ${SERVICE_NAME} && rm ${staged}`
  )
}

// --skip-env 时 index.html 仍要部署，UE_SERVER_ROOT 只能从远端已有 server.env 读取。
// Windows 远端 cat 的等价物是 type（cmd 内建），路径归一成反斜杠。
export function buildServerEnvReadCommand({ appDir, windows }) {
  const path = serverEnvPath(appDir, { windows })
  return windows ? `type "${path}"` : `cat ${path}`
}

// 规则文本单一事实源在 serverEnv.mjs（setup 首装自动写 sudoers 也用它），此处保留别名。
export const sudoersHint = buildDeploySudoers

function die(msg) {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`)
  process.exit(1)
}

function warn(msg) {
  console.warn(`\x1b[33m⚠ ${msg}\x1b[0m`)
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

async function main() {
  const { mode, explicit } = loadEnv()
  if (!explicit) {
    die(
      '服务器部署必须显式指定目标环境：pnpm server:deploy -- --env prod（生产）或 --env test（测试机），或设 UE_ENV\n' +
        '  连接参数从对应 .env.<mode> 读取，见 .env.example；本地联调请用 pnpm server:serve',
    )
  }

  const args = parseArgs(process.argv.slice(2))
  const config = buildConfig(args, process.env)

  if (!config.host) die(`缺少 --host（或 UE_RELEASE_HOST，可放 .env.${mode}）`)
  if (!config.user) die(`缺少 --user（或 UE_RELEASE_USER，可放 .env.${mode}）`)

  const isWindowsTarget = isWindowsAppDir(config.appDir)

  const localVersion = extractLocalVersion(readFileSync(serverSource, 'utf8'))
  if (!localVersion) die(`无法从 ${serverSource} 读到 SERVER_VERSION——确认该常量声明未被改动`)

  console.log(`\n🔍 检查远端版本 ${config.healthUrl}`)
  const remoteVersion = await fetchVersion(config.healthUrl)
  const assessment = assessVersions(localVersion, remoteVersion)
  if (assessment.needsForce && !config.force && !config.dryRun) {
    die(`${assessment.message}\n  确认无误要继续的话加 --force`)
  }
  if (remoteVersion === null) warn(assessment.message)
  else console.log(`   ${assessment.message}`)

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
    const spawnOpts = { stdio: 'inherit', timeout: opts.timeoutMs, ...opts.spawnOpts }
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
    if (res.status !== 0) die(`命令返回非零退出码 (${res.status}): ${printable}${opts.hint ?? ''}`)
  }

  // 本脚本全程非交互（sudo -n / schtasks 均不吃 stdin）：ssh 统一 -n（stdin=nul），
  // 规避 Win32-OpenSSH 继承控制台 stdin 的退出挂起，见 remoteShell.mjs 文件头。
  function sshExec(cmdStr, opts = {}) {
    run('ssh', buildSshArgs({ baseArgs: sshBase, remote, command: cmdStr }), opts)
  }

  // --skip-env 路径专用：ssh 抓远端 <appDir>/server.env，解析出 UE_SERVER_ROOT（失败返回 null）。
  function probeRemoteServerRoot(cmdStr) {
    const res = spawnSync('ssh', buildSshArgs({ baseArgs: sshBase, remote, command: cmdStr }), {
      encoding: 'utf8',
      timeout: TIMEOUT_MS.probe,
    })
    if (res.error || res.status !== 0) return null
    return parseEnvText(res.stdout ?? '').UE_SERVER_ROOT ?? null
  }

  // Windows 远端命令全是 cmd 语法（不做 cmd/PowerShell 兼容封装，理由见 remoteShell.mjs
  // 文件头）——默认 shell 非 cmd 在首个远端命令前就 fail-fast。
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

  // 下载页 index.html 随 server.js 一并部署，落 <UE_SERVER_ROOT>/index.html（发布根，与安装目录解耦）。
  // 无 --skip-env 时与 server.env 同一份 renderServerEnv 派生；--skip-env 时只能从远端已有 server.env
  // 读取——远端连 server.env 都还没有说明首装走错入口（应 setupRemote 而非 deploy），拒绝并指路。
  let renderedEnv = null
  let serverRoot = null
  if (config.skipEnv) {
    console.log('⏭️  --skip-env：保留服务器上现有 server.env')
    const readCmd = buildServerEnvReadCommand({ appDir: config.appDir, windows: isWindowsTarget })
    if (config.dryRun) {
      console.log(`  [dry-run] ssh ${remote} "${readCmd}"   # 读远端 server.env 取 UE_SERVER_ROOT`)
      serverRoot = '<远端 server.env 的 UE_SERVER_ROOT>'
    } else {
      serverRoot = probeRemoteServerRoot(readCmd)
      if (serverRoot === null) {
        die(
          `远端 ${config.appDir} 下读不到 server.env 或其中没有 UE_SERVER_ROOT——index.html 需要落到发布根。\n` +
            '  未完成首装的机器请改用 pnpm server:setup -- --env <mode>（server:deploy 只做日常更新）',
        )
      }
    }
  } else {
    renderedEnv = renderServerEnv({ env: process.env, windows: isWindowsTarget, mode })
    serverRoot = renderedEnv.values.UE_SERVER_ROOT
  }
  if (!serverRoot) {
    die(
      `无法确定 UE_SERVER_ROOT——index.html 需要落到发布根（在 .env.${mode} 里配置 UE_SERVER_ROOT）`,
    )
  }

  console.log(`\n🚀 [${mode}] 部署 ${SERVICE_NAME} v${localVersion} → ${remote}:${config.appDir}`)
  if (config.dryRun) console.log('   (dry-run，不实际执行)\n')

  if (!config.dryRun && !config.yes) {
    if (!process.stdin.isTTY) die('非交互终端下必须加 --yes（或先用 --dry-run 检查）')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = (await rl.question('继续部署? [y/N] ')).trim().toLowerCase()
    rl.close()
    if (answer !== 'y' && answer !== 'yes') die('已取消')
  }

  if (isWindowsTarget) {
    assertRemoteCmdShell()
    console.log('🔐 检查远端计划任务与权限')
    sshExec(`schtasks /Query /TN ${TASK_NAME}`, {
      timeoutMs: TIMEOUT_MS.remote,
      hint:
        `\n  远端查询计划任务 ${TASK_NAME} 失败。请确认：\n` +
        `    1) 测试机已按 scripts/server/README.md 用 setup.ps1 完成首次安装\n` +
        `    2) ssh 登录用户属于 Administrators 组（Win32-OpenSSH 对管理员默认发放提升令牌）`,
    })
  } else {
    console.log('🔐 检查远端免密 sudo')
    // 探测锚点 /usr/bin/true 在 buildDeploySudoers 规则内（sudoers 只认精确命令匹配，
    // `sudo -n true` 对命令特定 NOPASSWD 规则必然失败）；无副作用、免密即过。
    sshExec('sudo -n /usr/bin/true', {
      timeoutMs: TIMEOUT_MS.remote,
      hint:
        `\n  部署用户缺免密 sudo。在服务器上执行 sudo visudo -f /etc/sudoers.d/${SERVICE_NAME}，加入：\n` +
        `    ${sudoersHint(config.user, config.appDir, serverRoot)}`,
    })
  }

  if (config.skipBundle) {
    if (!existsSync(bundleOutput))
      die(`--skip-bundle 但找不到 ${bundleOutput}，先跑 pnpm server:bundle`)
    console.log('⏭️  跳过打包，复用已有 dist/server.js')
  } else {
    console.log('📦 打包 dist/server.js')
    // 透传 --env：bundle 会按同一 mode 生成 dist/server.env，与首装产物完全一致。
    run('pnpm', ['server:bundle', '--', '--env', mode], {
      timeoutMs: TIMEOUT_MS.bundle,
      spawnOpts: { cwd: repoRoot, shell: process.platform === 'win32' },
    })
  }

  const stagedName = `server.js.v${localVersion}`
  const stagedRemotePath = isWindowsTarget ? stagedName : `~/${stagedName}`

  // 服务端运行时配置：从 .env.<mode> 提取白名单生成 server.env 一并上传。
  // 与 bundle 共用 renderServerEnv，保证首装与部署两条路生成的配置一致（renderedEnv 在前面
  // 解析 serverRoot 时已生成）。白名单外的键（UE_RELEASE_KEY 等部署侧机密）绝不上服务器。
  let serverEnvText = null
  if (!config.skipEnv) {
    serverEnvText = renderedEnv.text
    console.log(
      `⚙️  服务端配置 server.env（${renderedEnv.keys.length} 项）: ${renderedEnv.keys.join(', ')}`,
    )
    if (!config.dryRun) writeFileSync(stagedEnvOutput, serverEnvText)
  }

  console.log(`⬆️  上传 dist/server.js → ${remote}:${stagedRemotePath}`)
  run('scp', [...scpBase, bundleOutput, `${remote}:${stagedRemotePath}`], {
    timeoutMs: TIMEOUT_MS.scp,
  })
  if (serverEnvText !== null) {
    const stagedEnvName = `${SERVER_ENV_FILE}.v${localVersion}`
    const stagedEnvRemote = isWindowsTarget ? stagedEnvName : `~/${stagedEnvName}`
    console.log(`⬆️  上传 server.env → ${remote}:${stagedEnvRemote}`)
    run('scp', [...scpBase, stagedEnvOutput, `${remote}:${stagedEnvRemote}`], {
      timeoutMs: TIMEOUT_MS.scp,
    })
  }

  // 第三路：下载页 index.html。staged 命名与 server.js/server.env 同模式，安装时落发布根。
  const stagedPageName = `index.html.v${localVersion}`
  const stagedPageRemote = isWindowsTarget ? stagedPageName : `~/${stagedPageName}`
  console.log(`⬆️  上传下载页 index.html → ${remote}:${stagedPageRemote}`)
  run('scp', [...scpBase, downloadPageSource, `${remote}:${stagedPageRemote}`], {
    timeoutMs: TIMEOUT_MS.scp,
  })

  console.log(`🔁 安装并重启 ${isWindowsTarget ? `计划任务 ${TASK_NAME}` : SERVICE_NAME}`)
  run(
    'ssh',
    buildSshArgs({
      baseArgs: sshBase,
      remote,
      command: buildRemoteInstallCommand({
        appDir: config.appDir,
        serverRoot,
        version: localVersion,
        windows: isWindowsTarget,
        withEnv: serverEnvText !== null,
      }),
    }),
    {
      timeoutMs: TIMEOUT_MS.remote,
      hint: !isWindowsTarget
        ? `\n  若失败在某条 sudo -n cp 一步：老的 sudoers 规则没全部覆盖三条 cp 通道\n` +
          `  （server.env 与 index.html 是后加的）。在服务器上执行 sudo visudo -f /etc/sudoers.d/${SERVICE_NAME}，整行替换为：\n` +
          `    ${sudoersHint(config.user, config.appDir, serverRoot)}\n` +
          '  带了 --deploy-user 的 server:setup 重跑首装也会自动补齐。server.env 通道可先用 --skip-env 跳过；index.html 通道无开关。'
        : '',
    },
  )

  if (config.dryRun) {
    console.log(
      `\n\x1b[2m[dry-run] 健康验证将轮询 ${config.healthUrl} 断言 v${localVersion}\x1b[0m\n`,
    )
    return
  }

  console.log(`🩺 健康验证 ${config.healthUrl}`)
  for (let attempt = 1; attempt <= 10; attempt++) {
    const v = await fetchVersion(config.healthUrl)
    if (v === localVersion) {
      console.log(`\n\x1b[32m✓ 已部署 v${localVersion}，服务健康\x1b[0m\n`)
      return
    }
    if (v !== null) {
      warn(`第 ${attempt} 次探测返回 v${v}（期望 v${localVersion}），等待服务重启…`)
    }
    await sleep(1000)
  }
  die(
    `健康验证超时：${config.healthUrl} 未返回 v${localVersion}。\n` +
      (isWindowsTarget
        ? `  上服务器查看：ssh ${remote} "schtasks /Query /TN ${TASK_NAME} /V /FO LIST"`
        : `  上服务器看日志：ssh ${remote} journalctl -u ${SERVICE_NAME} -n 50`),
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
