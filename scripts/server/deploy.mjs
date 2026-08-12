#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  一条指令发布更新服务器：bundle → 上传 → 远端安装 → 重启 → 健康验证。
 *
 *  用法（在仓库根目录，生产必须显式指定 --env prod）:
 *    pnpm server:deploy -- --env prod
 *  或:
 *    UE_ENV=prod pnpm server:deploy
 *
 *  连接参数与 release:upload 同一套（.env / 环境变量 / 旗标三选一，见 .env.example）:
 *    --host / --user / --port / --key      ← UE_RELEASE_HOST / USER / PORT / KEY
 *    --app-dir                             ← UE_SERVER_APP_DIR（默认 /opt/universe-update-server）
 *    --health-url                          ← UE_SERVER_HEALTH_URL（默认 http://<host>/）
 *
 *  旗标:
 *    --dry-run       打印将执行的命令与版本比对，零副作用
 *    --yes           跳过交互确认（脚本化场景）
 *    --force         远端版本 >= 本地时仍强制部署（默认拦下，提醒 bump SERVER_VERSION）
 *    --skip-bundle   复用已有 dist/server.js，跳过重新打包
 *
 *  前置条件：远端为 Ubuntu/systemd，且部署用户配好免密 sudo（规则见 scripts/server/README.md
 *  第六节；缺失时本脚本会打印精确的 sudoers 配置后退出）。Windows 远端请按 README 手动步骤。
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { loadEnv } from '../lib/env.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')
const serverSource = join(__dirname, 'server.mjs')
const bundleOutput = join(__dirname, 'dist', 'server.js')
const SERVICE_NAME = 'universe-update-server'

export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--yes') out.yes = true
    else if (a === '--force') out.force = true
    else if (a === '--skip-bundle') out.skipBundle = true
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

// cp 成功才 restart，最后清理临时文件；sudo -n 保证非交互失败可确定诊断。
export function buildRemoteInstallCommand({ appDir, version }) {
  const staged = `~/server.js.v${version}`
  return `sudo -n cp ${staged} ${appDir}/server.mjs && sudo -n systemctl restart ${SERVICE_NAME} && rm ${staged}`
}

export function sudoersHint(user, appDir) {
  return (
    `${user} ALL=(root) NOPASSWD: /usr/bin/cp /home/${user}/server.js.v* ${appDir}/server.mjs, ` +
    `/usr/bin/systemctl restart ${SERVICE_NAME}`
  )
}

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
  const { mode } = loadEnv()
  if (mode !== 'prod') {
    die(
      '服务器部署必须显式指定生产环境：pnpm server:deploy -- --env prod（或 UE_ENV=prod）\n' +
        '  本地联调请用 pnpm server:serve，无需部署',
    )
  }

  const args = parseArgs(process.argv.slice(2))
  const config = buildConfig(args, process.env)

  if (!config.host) die('缺少 --host（或 UE_RELEASE_HOST，可放 .env.prod）')
  if (!config.user) die('缺少 --user（或 UE_RELEASE_USER，可放 .env.prod）')

  const isWindowsTarget = /^[A-Za-z]:[\\/]/.test(config.appDir) || config.appDir.includes('\\')
  if (isWindowsTarget) {
    die(
      'server:deploy 暂只支持 Ubuntu/systemd 远端；Windows 远端请按 scripts/server/README.md 第六节手动更新',
    )
  }

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
    const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit', ...opts.spawnOpts })
    if (res.error) die(`执行失败: ${printable}\n  ${res.error.message}`)
    if (res.status !== 0) die(`命令返回非零退出码 (${res.status}): ${printable}${opts.hint ?? ''}`)
  }

  console.log(`\n🚀 部署 ${SERVICE_NAME} v${localVersion} → ${remote}:${config.appDir}`)
  if (config.dryRun) console.log('   (dry-run，不实际执行)\n')

  if (!config.dryRun && !config.yes) {
    if (!process.stdin.isTTY) die('非交互终端下必须加 --yes（或先用 --dry-run 检查）')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = (await rl.question('继续部署? [y/N] ')).trim().toLowerCase()
    rl.close()
    if (answer !== 'y' && answer !== 'yes') die('已取消')
  }

  console.log('🔐 检查远端免密 sudo')
  run('ssh', [...sshBase, remote, 'sudo -n true'], {
    hint:
      `\n  部署用户缺免密 sudo。在服务器上执行 sudo visudo -f /etc/sudoers.d/${SERVICE_NAME}，加入：\n` +
      `    ${sudoersHint(config.user, config.appDir)}`,
  })

  if (config.skipBundle) {
    if (!existsSync(bundleOutput))
      die(`--skip-bundle 但找不到 ${bundleOutput}，先跑 pnpm server:bundle`)
    console.log('⏭️  跳过打包，复用已有 dist/server.js')
  } else {
    console.log('📦 打包 dist/server.js')
    run('pnpm', ['server:bundle'], {
      spawnOpts: { cwd: repoRoot, shell: process.platform === 'win32' },
    })
  }

  console.log(`⬆️  上传 dist/server.js → ${remote}:~/server.js.v${localVersion}`)
  run('scp', [...scpBase, bundleOutput, `${remote}:~/server.js.v${localVersion}`])

  console.log(`🔁 安装并重启 ${SERVICE_NAME}`)
  run('ssh', [
    ...sshBase,
    remote,
    buildRemoteInstallCommand({ appDir: config.appDir, version: localVersion }),
  ])

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
      `  上服务器看日志：ssh ${remote} journalctl -u ${SERVICE_NAME} -n 50`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
