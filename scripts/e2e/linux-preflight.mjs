/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  linux-preflight.mjs — 跑 e2e 前的秒级 Linux 环境预检。缺 Playwright 系统库（如
 *  libnspr4.so）时 Electron 启动即挂，harness 会对每个用例做 5/10/20s 退避重试，
 *  报错完全不指向根因；这里在跑测试前先探测，能自动修就自动修，不能修就秒级失败
 *  并给出精确修复指令。
 *
 *  流程（仅 linux 平台）：/mnt 挂载盘警告（只 warn 不失败）→ electron 二进制存在
 *  → ldd 检查系统库（缺则按 root/免密 sudo/交互 TTY 判定是否自动跑 install-deps，
 *  否则 fail fast）→ DISPLAY/Xvfb 检查。全部通过后设 UNIVERSE_E2E_PREFLIGHT_DONE=1
 *  供子进程继承，避免链路上重复预检。
 *
 *  环境变量开关：
 *    UNIVERSE_E2E_SKIP_PREFLIGHT=1   完全跳过预检
 *    UNIVERSE_E2E_PREFLIGHT_DONE=1   预检已通过（子进程继承，避免重复预检）
 *    TURBO_HASH                      已设（turbo 任务内，根入口已预检过）
 *
 *  本模块顶层零副作用，仅供 import（run-e2e.mjs / ensure-e2e-build.mjs 接线），
 *  纯函数 parseLddMissingLibs / decideFixMode 供单测直接调用。
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 解析 `ldd` 输出中 `=> not found` 的行，返回去重排序后的 lib 名。
 * 纯函数，供单测直接调用。
 */
export function parseLddMissingLibs(lddOutput) {
  const libs = new Set()
  for (const line of lddOutput.split('\n')) {
    const idx = line.indexOf('=>')
    if (idx === -1) continue
    const lib = line.slice(0, idx).trim()
    const target = line.slice(idx + 2).trim()
    if (lib && target.startsWith('not found')) libs.add(lib)
  }
  return [...libs].sort()
}

/**
 * 修复策略判定：root/免密 sudo 可直接自动修；仅交互 TTY 走 sudo 提示密码；其余
 * （agent / 非交互环境）fail fast。纯函数，供单测直接调用。
 */
export function decideFixMode({ isRoot, hasPasswordlessSudo, isInteractive }) {
  if (isRoot || hasPasswordlessSudo) return 'auto'
  if (isInteractive) return 'interactive'
  return 'manual'
}

function log(msg) {
  console.log(`[e2e-preflight] ${msg}`)
}

/** 检查 1：/mnt 挂载盘警告（只 warn 不失败）。 */
function warnIfOnMntMount() {
  let version = ''
  try {
    version = readFileSync('/proc/version', 'utf8')
  } catch {
    return
  }
  if (!/microsoft/i.test(version)) return
  if (!repoRoot.startsWith('/mnt/')) return
  console.warn(
    [
      '[e2e-preflight] 警告：仓库位于 /mnt 挂载盘，跨文件系统 I/O 极慢且 inotify 不可靠，',
      '[e2e-preflight] 依赖 fs-watch 的 spec 会超时；建议 clone 到 ~/ 下（详见 docs/development/wsl-e2e.md）。',
    ].join('\n'),
  )
}

/** 检查 2：electron 二进制存在。定位方式与 ensure-electron-binary.mjs 相同。 */
function locateElectronBinary() {
  const editorPkgPath = fileURLToPath(new URL('../../apps/editor/package.json', import.meta.url))
  let pkgDir
  try {
    pkgDir = dirname(createRequire(editorPkgPath).resolve('electron/package.json'))
  } catch {
    throw new Error(
      '[e2e-preflight] 无法定位 electron 包（electron/package.json 解析失败）。\n' +
        '[e2e-preflight] 请先运行 pnpm install（install 钩子 scripts/ensure-electron-binary.mjs 会自愈补齐）。',
    )
  }

  let exeName
  try {
    exeName = readFileSync(join(pkgDir, 'path.txt'), 'utf8').trim()
  } catch {
    throw new Error(
      '[e2e-preflight] electron 包的 path.txt 缺失或不可读。\n' +
        '[e2e-preflight] 请先运行 pnpm install（install 钩子 scripts/ensure-electron-binary.mjs 会自愈补齐）。',
    )
  }

  if (!exeName || !existsSync(join(pkgDir, 'dist', exeName))) {
    throw new Error(
      `[e2e-preflight] electron 二进制缺失（dist/${exeName}）。\n` +
        '[e2e-preflight] 请先运行 pnpm install（install 钩子 scripts/ensure-electron-binary.mjs 会自愈补齐）。',
    )
  }
  return join(pkgDir, 'dist', exeName)
}

function runLdd(electronBinary) {
  return spawnSync('ldd', [electronBinary], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  })
}

/** 缺失库 + 根因 + 修复指令的多行错误文案。 */
function missingLibsMessage(missing, extra) {
  const lines = []
  if (extra) lines.push(`[e2e-preflight] ${extra}`)
  lines.push(`[e2e-preflight] 缺失系统库：${missing.join(', ')}`)
  lines.push('[e2e-preflight] 根因：Playwright/Electron 系统依赖未安装。')
  lines.push('[e2e-preflight] 修复（二选一）：')
  lines.push('[e2e-preflight]   1) bash scripts/wsl/bootstrap.sh（一键初始化）')
  lines.push(
    '[e2e-preflight]   2) pnpm --filter @universe-editor/editor exec playwright install-deps（需 sudo）',
  )
  lines.push('[e2e-preflight] 详见 docs/development/wsl-e2e.md')
  return lines.join('\n')
}

/** 检查 3：系统库。缺失时按策略自动修或 fail fast。 */
function checkSystemLibs(electronBinary) {
  let ldd = runLdd(electronBinary)
  if (ldd.error) {
    log('未找到 ldd，跳过系统库检查')
    return
  }
  let missing = parseLddMissingLibs(ldd.stdout ?? '')
  if (missing.length === 0) return

  const isRoot = process.getuid?.() === 0
  const sudo = spawnSync('sudo', ['-n', 'true'])
  const hasPasswordlessSudo = sudo.status === 0
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const mode = decideFixMode({ isRoot, hasPasswordlessSudo, isInteractive })

  if (mode === 'manual') {
    throw new Error(missingLibsMessage(missing))
  }

  log(`缺失系统库：${missing.join(', ')}`)
  log(
    `将执行：pnpm --filter @universe-editor/editor exec playwright install-deps` +
      (mode === 'interactive' ? '（sudo 可能在终端提示输入密码）' : ''),
  )
  const install = spawnSync(
    'pnpm',
    ['--filter', '@universe-editor/editor', 'exec', 'playwright', 'install-deps'],
    { stdio: 'inherit', cwd: repoRoot },
  )
  if (install.error) {
    throw new Error(`[e2e-preflight] install-deps 启动失败：${install.error.message}`)
  }
  if (install.status !== 0) {
    throw new Error(missingLibsMessage(missing, `install-deps 失败（退出码 ${install.status}）：`))
  }

  ldd = runLdd(electronBinary)
  const still = ldd.error ? missing : parseLddMissingLibs(ldd.stdout ?? '')
  if (still.length > 0) {
    throw new Error(missingLibsMessage(still, 'install-deps 完成后仍缺失：'))
  }
}

/** 检查 4：DISPLAY / Xvfb。 */
function checkDisplay() {
  if (process.env.DISPLAY) return
  const whichXvfb = spawnSync('which', ['Xvfb'])
  if (whichXvfb.status === 0) {
    log('无 DISPLAY，e2e-harness 将自动启动 Xvfb 离屏运行')
    return
  }
  throw new Error(
    [
      '[e2e-preflight] 无图形环境且未安装 Xvfb，Electron 无法启动。',
      '[e2e-preflight] 修复：bash scripts/wsl/bootstrap.sh，或 sudo apt-get install -y xvfb，',
      '[e2e-preflight] 或在 WSLg / 有 X 的环境运行（详见 docs/development/wsl-e2e.md）。',
    ].join('\n'),
  )
}

/** 主入口。失败 throw 多行 message，由调用方打印并 exit。 */
export async function runLinuxPreflight() {
  if (process.platform !== 'linux') return
  if (process.env.UNIVERSE_E2E_SKIP_PREFLIGHT === '1') return
  if (process.env.UNIVERSE_E2E_PREFLIGHT_DONE === '1') return
  if (process.env.TURBO_HASH) return

  const started = Date.now()

  warnIfOnMntMount()
  const electronBinary = locateElectronBinary()
  checkSystemLibs(electronBinary)
  checkDisplay()

  process.env.UNIVERSE_E2E_PREFLIGHT_DONE = '1'
  log(`预检通过（${Date.now() - started}ms）`)
}
