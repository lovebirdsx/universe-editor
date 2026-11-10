#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  refresh-installed-editor：把主 worktree 的最新 main 生产构建后覆盖本机安装版并重启。
 *
 *  前台进程只做预检，然后通过 WMI Win32_Process.Create 启动独立 worker。编辑器用 Windows
 *  Job Object（KILL_ON_JOB_CLOSE）管理本地子进程树，普通 detached 子进程仍会随编辑器退出
 *  被杀；WMI 创建的进程不在该 Job 内，才能在关闭编辑器后继续完成覆盖和重启。
 *
 *  执行时机：先通过安装版的 `--agent-sessions` 查询当前所有会话。除调用本 skill 的
 *  会话外只要还有正在运行（running / ask / background）的会话就中止；构建成功、关闭
 *  编辑器前再查一次，期间新开的会话同样会阻止关闭。调用会话本身允许继续运行，
 *  关闭编辑器时会一并结束。安装版不支持该查询时直接拒绝执行。
 *
 *  顺序刻意是「构建成功后才关闭编辑器」：构建失败时安装版不受影响，编译期间也可继续使用。
 *  关闭用 `Universe Editor.exe --quit`：第二个实例把参数转发给已运行的主实例，主实例走
 *  File → Exit 的 app.quit() 管线（before-quit 先快照全部窗口，will-quit 清理 sentinel），
 *  不强杀、不逐窗口 WM_CLOSE（逐窗关闭会重写 session、收缩恢复列表）。
 *  从编辑器内调用时还会带上 `--quit-skip-session=<调用会话 id>`：编辑器退出确认只豁免
 *  这一个会话（它的工作本来就会被预期的刷新中断），其它运行中会话仍照常拦截；安装版
 *  较旧、不支持该参数时回退为纯 `--quit`（可能弹一次确认框，更新一次安装版后消失）。
 *  覆盖用 robocopy /E 而不是 /MIR：只覆盖同名文件，保留卸载器等安装器专属文件。
 *  只关闭可执行路径位于安装目录下的进程，避免误杀 dev / 其它 worktree 实例。
 *--------------------------------------------------------------------------------------------*/

import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PRODUCT_NAME = 'Universe Editor'
const EXE_NAME = 'Universe Editor.exe'
const UNINSTALLER_NAME = 'Uninstall Universe Editor.exe'
const WIN_UNPACKED_REL = 'apps/editor/release/win-unpacked'
const PACKAGE_EDITOR_REL = 'scripts/release/package-editor.mjs'
const RUNTIME_RESOURCES_REL = 'scripts/release/runtime-resources.mjs'
const DEFAULT_ENV_MODE = 'prod'
const DEFAULT_GRACE_SECONDS = 60
const POLL_INTERVAL_MS = 1000
const AGENT_SESSIONS_FLAG = '--agent-sessions'
const AGENT_SESSIONS_PROTOCOL = 1
const AGENT_SESSIONS_TIMEOUT_MS = 30_000
/**
 * Exempts the session that invoked this skill from the editor's quit
 * confirmation. Every other running session still prompts; the flag is optional
 * so older installed builds fall back to the plain `--quit` behavior.
 */
const QUIT_SKIP_SESSION_FLAG = '--quit-skip-session='
/** Killing the editor must not interrupt sessions with work in flight. */
const BLOCKING_SESSION_STATUSES = new Set(['running', 'ask', 'background'])
const OTHER_SESSIONS_EXIT_CODE = 11
const SESSION_QUERY_EXIT_CODE = 12
const RUN_ROOT = join(tmpdir(), 'refresh-installed-editor')
const LAST_RESULT_FILE = join(RUN_ROOT, 'last-result.json')
const RUN_LOCK_FILE = join(RUN_ROOT, 'run.lock.json')

class CliError extends Error {
  constructor(message, exitCode) {
    super(message)
    this.exitCode = exitCode
  }
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    foreground: false,
    skipBuild: false,
    skipPull: false,
    strictNotes: false,
    noRestart: false,
    allowMissingEnv: false,
    envMode: DEFAULT_ENV_MODE,
    graceSeconds: DEFAULT_GRACE_SECONDS,
    installDir: undefined,
    mainWorktree: undefined,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--foreground') options.foreground = true
    else if (arg === '--skip-build') options.skipBuild = true
    else if (arg === '--skip-pull') options.skipPull = true
    else if (arg === '--strict-notes') options.strictNotes = true
    else if (arg === '--no-restart') options.noRestart = true
    else if (arg === '--allow-missing-env') options.allowMissingEnv = true
    else if (arg === '--env' || arg.startsWith('--env=')) {
      const { value, next } = takeValue(argv, i, '--env')
      options.envMode = value
      i = next
    } else if (arg === '--install-dir' || arg.startsWith('--install-dir=')) {
      const { value, next } = takeValue(argv, i, '--install-dir')
      options.installDir = resolve(value)
      i = next
    } else if (arg === '--main-worktree' || arg.startsWith('--main-worktree=')) {
      const { value, next } = takeValue(argv, i, '--main-worktree')
      options.mainWorktree = resolve(value)
      i = next
    } else if (arg === '--grace-timeout' || arg.startsWith('--grace-timeout=')) {
      const { value, next } = takeValue(argv, i, '--grace-timeout')
      const seconds = Number(value)
      if (!Number.isInteger(seconds) || seconds <= 0) {
        throw new CliError('--grace-timeout 必须是正整数（秒）', 2)
      }
      options.graceSeconds = seconds
      i = next
    } else {
      throw new CliError(`未知参数: ${arg}（--help 查看用法）`, 2)
    }
  }

  if (!/^[a-z0-9-]+$/.test(options.envMode)) {
    throw new CliError(`非法 --env 值 "${options.envMode}"：只允许 [a-z0-9-]`, 2)
  }
  return options
}

function takeValue(argv, index, name) {
  const arg = argv[index]
  if (arg === name) {
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new CliError(`${name} 需要一个值`, 2)
    return { value, next: index + 1 }
  }
  const value = arg.slice(name.length + 1)
  if (!value) throw new CliError(`${name} 需要一个值`, 2)
  return { value, next: index }
}

function log(message) {
  console.log(`[refresh] ${message}`)
}

function warn(message) {
  console.warn(`[refresh] ⚠ ${message}`)
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    windowsHide: true,
    shell: options.shell ?? false,
  })
  if (result.error) {
    throw new CliError(`${command} 启动失败: ${result.error.message}`, options.exitCode ?? 1)
  }
  return result
}

function capture(command, args, options = {}) {
  const result = runCapture(command, args, options)
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim()
    throw new CliError(
      `${command} ${args.join(' ')} 失败 (exit ${result.status})${detail ? `\n${detail}` : ''}`,
      options.exitCode ?? 1,
    )
  }
  return result.stdout
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: 'inherit',
    windowsHide: false,
    shell: options.shell ?? false,
  })
  if (result.error) {
    throw new CliError(`${command} 启动失败: ${result.error.message}`, options.exitCode ?? 1)
  }
  if (result.status !== 0) {
    throw new CliError(
      `${command} ${args.join(' ')} 失败 (exit ${result.status})`,
      options.exitCode ?? 1,
    )
  }
}

function pathKey(value) {
  return resolve(value).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

function samePath(a, b) {
  return pathKey(a) === pathKey(b)
}

function isUnder(child, parent) {
  const childKey = pathKey(child)
  const parentKey = pathKey(parent)
  return childKey === parentKey || childKey.startsWith(`${parentKey}\\`)
}

function resolveMainWorktree(explicit) {
  if (explicit) {
    const candidate = resolve(explicit)
    if (!existsSync(candidate)) throw new CliError(`主 worktree 不存在: ${candidate}`, 3)
    const main = realpathSync.native(candidate)
    assertMainWorktree(main)
    return main
  }
  const commonDir = capture(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: process.cwd(), exitCode: 3 },
  ).trim()
  const main = realpathSync.native(dirname(commonDir))
  assertMainWorktree(main)
  return main
}

function assertMainWorktree(main) {
  if (!existsSync(main)) throw new CliError(`主 worktree 不存在: ${main}`, 3)
  const top = capture('git', ['-C', main, 'rev-parse', '--show-toplevel'], {
    exitCode: 3,
  }).trim()
  if (!samePath(top, main)) {
    throw new CliError(`--main-worktree 不是 git worktree 根目录: ${main}`, 3)
  }
  const branch = capture('git', ['-C', main, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    exitCode: 3,
  }).trim()
  if (branch !== 'main') {
    throw new CliError(
      `主 worktree 当前分支是 "${branch}"，不是 main。请切回 main，或用 --main-worktree 指定 main 的 worktree。`,
      3,
    )
  }
  if (existsSync(join(main, '.git', 'index.lock'))) {
    throw new CliError('主 worktree 正在被 git 操作（存在 .git/index.lock），请稍后重试', 3)
  }
}

function checkWorktreeClean(main) {
  const status = capture(
    'git',
    ['-C', main, 'status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all'],
    { exitCode: 3 },
  ).trim()
  if (!status) return
  const lines = status.split(/\r?\n/)
  const preview = lines.slice(0, 20).join('\n')
  throw new CliError(
    `主 worktree 不干净，已中止（不会自动 stash/reset/clean）：\n${preview}${
      lines.length > 20 ? `\n... 共 ${lines.length} 项` : ''
    }\n请先提交或清理，或使用 --skip-pull。`,
    3,
  )
}

function parseSubmoduleStatus(output) {
  const entries = []
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue
    const match = /^([-+ U])([0-9a-f]{40,64})\s+(.+?)(?:\s+\(.*\))?$/.exec(line)
    if (!match) continue
    entries.push({ flag: match[1], path: match[3].trim() })
  }
  return entries
}

function checkSubmodules(main, skipPull) {
  const output = capture('git', ['-C', main, 'submodule', 'status', '--recursive'], {
    exitCode: 3,
  })
  const entries = parseSubmoduleStatus(output)
  const dirty = []
  for (const entry of entries) {
    if (entry.flag === '-') continue
    if (entry.flag === '+' || entry.flag === 'U') {
      dirty.push(`${entry.path}（指针${entry.flag === '+' ? '与索引不一致' : '冲突'}）`)
      continue
    }
    const subStatus = capture(
      'git',
      ['-C', join(main, entry.path), 'status', '--porcelain', '--ignore-submodules=all'],
      { exitCode: 3 },
    ).trim()
    if (subStatus) dirty.push(`${entry.path}（有未提交改动）`)
  }
  if (dirty.length > 0) {
    const detail = `submodule 状态异常：\n${dirty.join('\n')}`
    if (skipPull) warn(`${detail}\n--skip-pull 下按现状构建`)
    else throw new CliError(`${detail}\n请先提交或清理，或使用 --skip-pull。`, 3)
  }
  return entries
}

function updateSubmodules(main) {
  log('更新 submodule 到主 worktree 记录的版本…')
  run('git', ['-C', main, 'submodule', 'update', '--init', '--recursive'], {
    exitCode: 4,
  })
}

function checkEnvFile(main, envMode, allowMissing) {
  const file = join(main, `.env.${envMode}`)
  if (existsSync(file)) return file
  const message = `未找到 .env.${envMode}（主 worktree: ${file}）`
  if (allowMissing) {
    warn(`${message}；继续打包，配置可能回退到占位值`)
    return undefined
  }
  throw new CliError(
    `${message}。请先准备该文件，或用 --env <mode> 指定其它环境，或加 --allow-missing-env。`,
    3,
  )
}

function resolveInstallDir(explicit) {
  const localAppData = process.env.LOCALAPPDATA
  if (!explicit && !localAppData) {
    throw new CliError('LOCALAPPDATA 未设置，无法定位默认安装目录；请用 --install-dir 指定', 3)
  }
  const dir = resolve(explicit ?? join(localAppData, 'Programs', PRODUCT_NAME))
  if (!existsSync(dir)) throw new CliError(`安装目录不存在: ${dir}`, 3)
  const exe = join(dir, EXE_NAME)
  if (!existsSync(exe)) throw new CliError(`安装目录缺少 ${EXE_NAME}: ${dir}`, 3)
  const uninstaller = join(dir, UNINSTALLER_NAME)
  if (!existsSync(uninstaller)) {
    warn(`安装目录缺少卸载器 ${UNINSTALLER_NAME}；继续，但目标可能不是 NSIS 安装版`)
  }
  return { dir, exe, uninstaller }
}

function assertSafeInstallDir(dir, main) {
  if (samePath(dir, parse(dir).root)) {
    throw new CliError(`拒绝对盘符根目录执行覆盖: ${dir}`, 3)
  }
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  if (isUnder(dir, systemRoot)) {
    throw new CliError(`拒绝操作系统目录: ${dir}`, 3)
  }
  for (const programFiles of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (programFiles && isUnder(dir, programFiles)) {
      throw new CliError(`拒绝操作系统级安装目录: ${dir}`, 3)
    }
  }
  if (isUnder(dir, main) || isUnder(main, dir)) {
    throw new CliError(`安装目录与主 worktree 重叠，拒绝覆盖: ${dir}`, 3)
  }
}

function readEditorVersion(main) {
  const pkg = JSON.parse(readFileSync(join(main, 'apps/editor/package.json'), 'utf8'))
  return pkg.version
}

function readExeVersion(exe) {
  if (!existsSync(exe)) return undefined
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-Item -LiteralPath $env:UE_REFRESH_EXE).VersionInfo.FileVersion',
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, UE_REFRESH_EXE: exe },
    },
  )
  if (result.status !== 0) return undefined
  return result.stdout.trim() || undefined
}

function listProcesses() {
  const command = [
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '@(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, ExecutablePath, Name, CreationDate) | ConvertTo-Json -Compress',
  ].join('; ')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error) {
    throw new CliError(`PowerShell 启动失败: ${result.error.message}`, 7)
  }
  if (result.status !== 0) {
    throw new CliError(`枚举进程失败: ${(result.stderr || '').trim()}`, 7)
  }
  const text = result.stdout.trim()
  if (!text) return []
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CliError('解析进程列表失败（PowerShell 输出不是合法 JSON）', 7)
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  return list
    .filter((item) => item && item.ExecutablePath)
    .map((item) => ({
      pid: Number(item.ProcessId),
      parentPid: Number(item.ParentProcessId),
      path: String(item.ExecutablePath),
      name: String(item.Name ?? ''),
      creationDate: parseWmiDate(item.CreationDate),
    }))
}

/** PowerShell 5.1 把 DateTime 序列化成 `/Date(ms)/`，新版可能是 ISO 字符串。 */
function parseWmiDate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  const match = /\/Date\((\d+)\)\//.exec(value)
  if (match) return Number(match[1])
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function listInstallProcesses(installDir) {
  return listProcesses().filter((item) => isUnder(item.path, installDir))
}

function gitHead(main) {
  return capture('git', ['-C', main, 'rev-parse', 'HEAD'], { exitCode: 4 }).trim()
}

function pullMain(main) {
  const oldHead = gitHead(main)
  log(`拉取主 worktree main（当前 ${oldHead.slice(0, 8)}）…`)
  const result = spawnSync('git', ['-C', main, 'pull', '--ff-only', '--no-recurse-submodules'], {
    stdio: 'inherit',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    windowsHide: false,
  })
  if (result.error) {
    throw new CliError(`git pull 启动失败: ${result.error.message}`, 4)
  }
  if (result.status !== 0) {
    throw new CliError(`git pull 失败 (exit ${result.status})；主 worktree 未更新`, 4)
  }
  const newHead = gitHead(main)
  if (oldHead === newHead) log('已是最新 main')
  else log(`main 已更新: ${oldHead.slice(0, 8)} -> ${newHead.slice(0, 8)}`)
  return { oldHead, newHead }
}

function installDepsIfNeeded(main, oldHead, newHead) {
  const modulesManifest = join(main, 'node_modules', '.modules.yaml')
  if (oldHead === newHead && existsSync(modulesManifest)) {
    log('依赖清单未变化，跳过 pnpm install')
    return
  }
  const changed = capture(
    'git',
    [
      '-C',
      main,
      'diff',
      '--name-only',
      oldHead,
      newHead,
      '--',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'package.json',
      '.npmrc',
      'patches',
    ],
    { exitCode: 5 },
  ).trim()
  if (!changed && existsSync(modulesManifest)) {
    log('依赖清单未变化，跳过 pnpm install')
    return
  }
  log(
    changed
      ? `依赖清单变化，执行 pnpm install: ${changed.split(/\r?\n/).join(', ')}`
      : '缺少 node_modules，执行 pnpm install',
  )
  run('pnpm', ['install', '--frozen-lockfile'], { cwd: main, shell: true, exitCode: 5 })
}

function ensureDeps(main) {
  const modulesManifest = join(main, 'node_modules', '.modules.yaml')
  if (existsSync(modulesManifest)) {
    log('--skip-pull：沿用现有 node_modules')
    return
  }
  log('缺少 node_modules，执行 pnpm install')
  run('pnpm', ['install', '--frozen-lockfile'], { cwd: main, shell: true, exitCode: 5 })
}

function buildProduction(main, options) {
  const entry = join(main, PACKAGE_EDITOR_REL)
  if (!existsSync(entry)) throw new CliError(`缺少打包入口: ${entry}`, 6)
  const args = ['--win', 'dir', '--env', options.envMode]
  if (!options.strictNotes) args.push('--no-notes-gate')
  log(`生产构建：node ${PACKAGE_EDITOR_REL} ${args.join(' ')}`)
  log('构建包含 runtime staging、workspace 包和 electron-builder，可能需要数分钟…')
  run(process.execPath, [entry, ...args], { cwd: main, exitCode: 6 })
}

function installedEditorEnv() {
  const env = { ...process.env }
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_NO_ATTACH_CONSOLE',
    'NODE_OPTIONS',
    'UNIVERSE_E2E',
    'UNIVERSE_USER_DATA_DIR',
    'UNIVERSE_CONFIG_DIR',
    'UE_ENV',
  ]) {
    delete env[key]
  }
  return env
}

/** 安装版是否支持 `--agent-sessions`（判断依据是 app.asar 里的命令字符串）。 */
function installedSupportsAgentSessions(install) {
  const asar = join(install.dir, 'resources', 'app.asar')
  return existsSync(asar) && fileContainsText(asar, AGENT_SESSIONS_FLAG)
}

/** 安装版是否支持 `--quit-skip-session=`（旧版本只有纯 `--quit`）。 */
function installedSupportsQuitSkipSession(install) {
  const asar = join(install.dir, 'resources', 'app.asar')
  return existsSync(asar) && fileContainsText(asar, QUIT_SKIP_SESSION_FLAG)
}

function fileContainsText(file, needle) {
  const needleBuffer = Buffer.from(needle)
  const chunkSize = 1 << 20
  const buffer = Buffer.alloc(chunkSize)
  const fd = openSync(file, 'r')
  try {
    let carry = Buffer.alloc(0)
    while (true) {
      const read = readSync(fd, buffer, 0, chunkSize, null)
      if (read <= 0) return false
      const chunk =
        carry.length > 0
          ? Buffer.concat([carry, buffer.subarray(0, read)])
          : buffer.subarray(0, read)
      if (chunk.includes(needleBuffer)) return true
      carry = Buffer.from(chunk.subarray(Math.max(0, chunk.length - needleBuffer.length + 1)))
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * 调用本 skill 的会话由 CLAUDE_CODE_SESSION_ID 标识，它同时是 ACP 会话的
 * durable id（编辑器查询结果里的 agentSessionId）。没有该变量时无法认领调用
 * 会话，任何正在运行的会话都会被当成“其它会话”。
 */
function resolveInvokingSession() {
  const agentSessionId = process.env.CLAUDE_CODE_SESSION_ID?.trim() || undefined
  return agentSessionId ? { agentSessionId } : undefined
}

function queryAgentSessions(install) {
  if (!installedSupportsAgentSessions(install)) {
    throw new CliError(
      `当前安装版不支持 "${AGENT_SESSIONS_FLAG}" 会话查询，无法确认其它会话是否在运行。` +
        '请先手动更新到包含该查询命令的编辑器版本。',
      SESSION_QUERY_EXIT_CODE,
    )
  }
  log(`查询会话：${EXE_NAME} ${AGENT_SESSIONS_FLAG}`)
  const result = spawnSync(install.exe, [AGENT_SESSIONS_FLAG], {
    cwd: install.dir,
    env: installedEditorEnv(),
    encoding: 'utf8',
    windowsHide: true,
    timeout: AGENT_SESSIONS_TIMEOUT_MS,
  })
  if (result.error) {
    throw new CliError(`会话查询失败: ${result.error.message}`, SESSION_QUERY_EXIT_CODE)
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim()
    throw new CliError(
      `会话查询失败 (exit ${result.status})${detail ? `: ${detail}` : ''}`,
      SESSION_QUERY_EXIT_CODE,
    )
  }
  const snapshot = parseAgentSessionsOutput(result.stdout)
  if (!snapshot) {
    throw new CliError('会话查询没有返回可解析的 JSON', SESSION_QUERY_EXIT_CODE)
  }
  if (!Array.isArray(snapshot.failedWindows) || snapshot.failedWindows.length > 0) {
    throw new CliError(
      `会话查询不完整（未响应的窗口: ${JSON.stringify(snapshot.failedWindows ?? [])}），已中止`,
      SESSION_QUERY_EXIT_CODE,
    )
  }
  return snapshot
}

function parseAgentSessionsOutput(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = lines[i].trim()
    if (!text.startsWith('{')) continue
    try {
      const parsed = JSON.parse(text)
      if (parsed && parsed.protocol === AGENT_SESSIONS_PROTOCOL && Array.isArray(parsed.sessions)) {
        return parsed
      }
    } catch {
      // 继续向前找可解析的那一行。
    }
  }
  return undefined
}

function findOtherRunningSessions(snapshot, invoking) {
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : []
  return sessions.filter(
    (session) =>
      session &&
      typeof session === 'object' &&
      BLOCKING_SESSION_STATUSES.has(String(session.status)) &&
      !isInvokingSessionSummary(session, invoking),
  )
}

function isInvokingSessionSummary(session, invoking) {
  if (!invoking?.agentSessionId) return false
  return (
    session.agentSessionId === invoking.agentSessionId ||
    session.sessionId === invoking.agentSessionId
  )
}

function formatSessionSummary(session) {
  const agent = session.agentId ? String(session.agentId) : 'agent'
  const status = session.status ? String(session.status) : 'unknown'
  const title = session.title ? `「${String(session.title)}」` : ''
  const windowInfo = Number.isInteger(session.windowId) ? `，窗口 ${session.windowId}` : ''
  const workspace = session.workspaceName ? `，工作区 ${session.workspaceName}` : ''
  return `${agent}${title}（${status}${windowInfo}${workspace}）`
}

/**
 * 查询并返回“其它正在运行的会话”。安装版未运行时无需查询（没有可中断的工作）。
 * `editorRunning` 由调用方从已有的进程枚举传入，避免重复拉起 PowerShell。
 */
function collectOtherRunningSessions(install, invoking, editorRunning) {
  if (!editorRunning) return { snapshot: undefined, others: [] }
  const snapshot = queryAgentSessions(install)
  return { snapshot, others: findOtherRunningSessions(snapshot, invoking) }
}

function otherSessionsError(others, phase) {
  const list = others.map((session) => `  - ${formatSessionSummary(session)}`).join('\n')
  const retry =
    phase === '关闭编辑器前' ? '（构建产物已生成，结束会话后可加 --skip-build 重跑）' : ''
  return new CliError(
    `${phase}检测到其它正在运行的 agent 会话：\n${list}\n` +
      `已中止，不会关闭编辑器。请先结束这些会话后重跑${retry}。`,
    OTHER_SESSIONS_EXIT_CODE,
  )
}

/**
 * 用 `Universe Editor.exe --quit` 请求已运行的安装版退出。第二个实例拿不到
 * single-instance 锁，会把 argv 转发给主实例；主实例按 File → Exit 的
 * app.quit() 管线退出（before-quit 先快照全部窗口，再 will-quit 清理）。
 * 不要改回逐窗口 WM_CLOSE/taskkill：逐窗关闭会在每次 close/closed 时重写
 * session、收缩恢复列表，且强杀会留下异常退出 sentinel。
 */
function requestInstalledEditorQuit(install, invoking) {
  const args = ['--quit']
  if (invoking?.agentSessionId) {
    if (installedSupportsQuitSkipSession(install)) {
      args.push(`${QUIT_SKIP_SESSION_FLAG}${invoking.agentSessionId}`)
    } else {
      warn(
        `安装版不支持 "${QUIT_SKIP_SESSION_FLAG}"：关闭时可能出现调用会话的退出确认框；` +
          '完成一次安装版更新后该确认框会自动消失。',
      )
    }
  }
  log(`请求编辑器正常退出：${args.join(' ')}（等价于 File → Exit）…`)
  const result = spawnSync(install.exe, args, {
    cwd: install.dir,
    env: installedEditorEnv(),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  })
  // 第二个实例自身只负责转发并快速退出；非零退出码不单独判失败，
  // 以安装目录进程是否全部消失为准。
  if (result.error) {
    warn(`--quit 启动失败: ${result.error.message}；继续观察安装版是否退出`)
  }
}

async function closeInstallProcesses(install, invoking, graceSeconds) {
  let processes = listInstallProcesses(install.dir)
  if (processes.length === 0) {
    log('安装版未运行，跳过关闭')
    return 0
  }
  const initialCount = processes.length
  requestInstalledEditorQuit(install, invoking)
  const deadline = Date.now() + graceSeconds * 1000
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    processes = listInstallProcesses(install.dir)
    if (processes.length === 0) {
      log('安装版已正常退出')
      return initialCount
    }
  }
  const detail = processes.map((item) => `${item.name}(${item.pid})`).join(', ')
  throw new CliError(
    `编辑器在 ${graceSeconds}s 内没有退出（可能有未保存改动、运行中的会话或确认框等待处理）。` +
      `脚本不会强杀；请手动 File → Exit 后加 --skip-build 重跑。剩余进程: ${detail}`,
    7,
  )
}

function copyBuildToInstall(sourceDir, installDir) {
  const sourceExe = join(sourceDir, EXE_NAME)
  if (!existsSync(sourceExe)) {
    throw new CliError(`构建产物不完整，缺少 ${sourceExe}`, 6)
  }
  log(`覆盖安装目录：${sourceDir} -> ${installDir}`)
  const result = spawnSync(
    'robocopy',
    [sourceDir, installDir, '/E', '/XJ', '/R:2', '/W:1', '/NP', '/NFL', '/NDL', '/NJH', '/NJS'],
    { encoding: 'utf8', windowsHide: true },
  )
  if (result.error) {
    throw new CliError(`robocopy 启动失败: ${result.error.message}`, 8)
  }
  // robocopy 的 0-7 都是成功位标志，>=8 才是错误
  if (result.status === null || result.status >= 8) {
    const detail = (result.stdout || '').trim().split(/\r?\n/).slice(-20).join('\n')
    throw new CliError(
      `robocopy 覆盖失败 (exit ${result.status})${detail ? `\n${detail}` : ''}`,
      8,
    )
  }
  log(`robocopy 完成 (exit ${result.status})`)
}

function verifyInstalledCopy(sourceDir, installDir, main) {
  const sourceExe = join(sourceDir, EXE_NAME)
  const installedExe = join(installDir, EXE_NAME)
  if (!existsSync(installedExe)) throw new CliError(`覆盖后缺少 ${installedExe}`, 8)
  const sourceExeStat = statSync(sourceExe)
  const installedExeStat = statSync(installedExe)
  if (sourceExeStat.size !== installedExeStat.size) {
    throw new CliError(
      `覆盖后 exe 大小不一致: ${installedExeStat.size} != ${sourceExeStat.size}`,
      8,
    )
  }
  const sourceAsar = join(sourceDir, 'resources', 'app.asar')
  const installedAsar = join(installDir, 'resources', 'app.asar')
  if (!existsSync(sourceAsar) || !existsSync(installedAsar)) {
    throw new CliError('覆盖后缺少 resources/app.asar', 8)
  }
  const sourceAsarStat = statSync(sourceAsar)
  const installedAsarStat = statSync(installedAsar)
  if (sourceAsarStat.size !== installedAsarStat.size) {
    throw new CliError('覆盖后 resources/app.asar 大小不一致', 8)
  }
  if (Math.abs(sourceAsarStat.mtimeMs - installedAsarStat.mtimeMs) > 2000) {
    throw new CliError('覆盖后 resources/app.asar 时间戳未更新', 8)
  }
  if (!existsSync(join(installDir, UNINSTALLER_NAME))) {
    throw new CliError(`覆盖后卸载器丢失: ${UNINSTALLER_NAME}`, 8)
  }
  log('校验安装目录资源…')
  run(
    process.execPath,
    [join(main, RUNTIME_RESOURCES_REL), 'verify-packaged', join(installDir, 'resources')],
    { cwd: main, exitCode: 8 },
  )
}

async function launchInstalledEditor(installDir, exe) {
  let spawnError
  const child = spawn(exe, [], {
    cwd: installDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: installedEditorEnv(),
  })
  child.on('error', (error) => {
    spawnError = error
  })
  child.unref()
  await sleep(2500)
  if (spawnError) throw new CliError(`启动编辑器失败: ${spawnError.message}`, 9)
  const processes = listInstallProcesses(installDir)
  if (processes.length === 0) {
    throw new CliError(
      `启动后未发现安装目录进程。可能有其它路径的 Universe Editor 实例占用了单实例锁；请手动启动: ${exe}`,
      9,
    )
  }
  const pids = processes.map((item) => item.pid).join(', ')
  log(`编辑器已启动（安装目录进程 PID: ${pids}）`)
  return pids
}

function upstreamBehind(main) {
  const result = spawnSync('git', ['-C', main, 'rev-list', '--count', 'HEAD..@{upstream}'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0) return undefined
  const count = Number(result.stdout.trim())
  return Number.isInteger(count) ? count : undefined
}

function preflight(options) {
  const main = resolveMainWorktree(options.mainWorktree)
  const install = resolveInstallDir(options.installDir)
  assertSafeInstallDir(install.dir, main)

  const sourceDir = join(main, WIN_UNPACKED_REL)
  const sourceExe = join(sourceDir, EXE_NAME)
  const sourceExists = existsSync(sourceExe)
  const editorVersion = readEditorVersion(main)
  const installedVersion = readExeVersion(install.exe)

  let envFile
  let submodules
  if (!options.skipBuild) {
    envFile = checkEnvFile(main, options.envMode, options.allowMissingEnv)
    if (!options.skipPull) checkWorktreeClean(main)
    submodules = checkSubmodules(main, options.skipPull)
  }

  const allProcesses = listProcesses()
  const installProcesses = allProcesses.filter((item) => isUnder(item.path, install.dir))
  const foreignProcesses = allProcesses.filter(
    (item) => item.name === EXE_NAME && !isUnder(item.path, install.dir),
  )
  const { snapshot: sessionSnapshot, others: otherSessions } = collectOtherRunningSessions(
    install,
    options.invokingSession,
    installProcesses.length > 0,
  )

  return {
    main,
    install,
    sourceDir,
    sourceExists,
    editorVersion,
    installedVersion,
    envFile,
    submodules,
    installProcesses,
    foreignProcesses,
    sessionSnapshot,
    otherSessions,
    invokingSession: options.invokingSession,
    quitSkipSessionSupported: installedSupportsQuitSkipSession(install),
  }
}

function printPreflightSummary(info) {
  log(`主 worktree: ${info.main}`)
  log(`安装目录: ${info.install.dir}`)
  log(`安装版版本: ${info.installedVersion ?? '未知'}；构建源码版本: ${info.editorVersion}`)
  if (info.sessionSnapshot === undefined) {
    log('安装版未运行：无会话需要检查')
  } else if (info.otherSessions.length === 0) {
    log(`会话检查: 无其它运行中的会话（共 ${info.sessionSnapshot.sessions.length} 个会话）`)
  } else {
    warn(
      `会话检查: ${info.otherSessions.length} 个其它会话正在运行:\n${info.otherSessions
        .map((session) => `  - ${formatSessionSummary(session)}`)
        .join('\n')}`,
    )
  }
  if (info.installProcesses.length > 0 && info.invokingSession?.agentSessionId) {
    if (info.quitSkipSessionSupported) {
      log('退出确认豁免: 支持 --quit-skip-session（调用会话不会触发确认框）')
    } else {
      warn(
        '退出确认豁免: 安装版不支持 --quit-skip-session，关闭时可能出现调用会话的确认框；' +
          '更新一次安装版后自动消失',
      )
    }
  }
  if (info.foreignProcesses.length > 0) {
    warn(
      `安装目录外还有 Universe Editor 进程: ${info.foreignProcesses
        .map((item) => `${item.pid} (${item.path})`)
        .join(', ')}；若它占用默认 userData，新实例可能被单实例锁转发`,
    )
  }
}

function printDryRun(options, info) {
  log('dry-run：只做预检，不执行任何写操作')
  log(`主 worktree: ${info.main}`)
  const head = capture('git', ['-C', info.main, 'rev-parse', 'HEAD'], { exitCode: 3 }).trim()
  log(`主 worktree HEAD: ${head.slice(0, 8)}（分支 main）`)
  const behind = upstreamBehind(info.main)
  if (behind !== undefined) {
    log(`落后 upstream: ${behind} 个提交（基于本地 remote-tracking ref，未 fetch）`)
  }
  if (options.skipBuild) {
    log('打包环境: 跳过（--skip-build）')
  } else {
    log(
      `打包环境: ${options.envMode}${
        info.envFile
          ? `（${info.envFile.split(/[\\/]/).pop()} 存在）`
          : '（未找到 env 文件，使用占位配置）'
      }`,
    )
  }
  log(`安装目录: ${info.install.dir}`)
  log(`安装版版本: ${info.installedVersion ?? '未知'}`)
  log(`构建源码版本: ${info.editorVersion}`)
  log(`运行中的安装目录进程: ${info.installProcesses.length}`)
  if (info.foreignProcesses.length > 0) {
    warn(
      `发现安装目录外的 Universe Editor 进程: ${info.foreignProcesses
        .map((item) => `${item.pid} (${item.path})`)
        .join(', ')}；它可能抢占单实例锁`,
    )
  }
  log(`现有构建产物: ${info.sourceExists ? '存在' : '不存在（正式运行会构建）'}`)
  if (options.invokingSession?.agentSessionId) {
    log(`调用会话: ${options.invokingSession.agentSessionId}`)
  } else {
    warn('调用会话: 无法识别（未设置 CLAUDE_CODE_SESSION_ID），任何运行中的会话都会被拦')
  }
  log(
    `退出确认豁免（${QUIT_SKIP_SESSION_FLAG}）: ${
      info.quitSkipSessionSupported ? '安装版支持' : '安装版不支持（关闭时可能弹确认框）'
    }`,
  )
  if (info.sessionSnapshot === undefined) {
    log('其它运行中的会话: 安装版未运行，无')
  } else if (info.otherSessions.length === 0) {
    log(`其它运行中的会话: 无（共 ${info.sessionSnapshot.sessions.length} 个会话，可以执行）`)
  } else {
    warn(
      `其它运行中的会话（正式运行会中止）:\n${info.otherSessions
        .map((session) => `  - ${formatSessionSummary(session)}`)
        .join('\n')}`,
    )
  }
  log('计划执行:')
  if (!options.skipBuild) {
    if (!options.skipPull) {
      console.log(`  git -C "${info.main}" pull --ff-only --no-recurse-submodules`)
      console.log(`  git -C "${info.main}" submodule update --init --recursive`)
    }
    console.log('  pnpm install --frozen-lockfile（仅在依赖清单变化时）')
    console.log(
      `  node "${join(info.main, PACKAGE_EDITOR_REL)}" --win dir --env ${options.envMode}${
        options.strictNotes ? '' : ' --no-notes-gate'
      }`,
    )
  } else {
    console.log('  （跳过构建，复用现有 win-unpacked）')
  }
  console.log(
    `  "${info.install.exe}" ${AGENT_SESSIONS_FLAG}（关闭前再次查询会话；有其它运行中的会话则中止）`,
  )
  const quitSkipArg =
    info.quitSkipSessionSupported && options.invokingSession?.agentSessionId
      ? ` ${QUIT_SKIP_SESSION_FLAG}${options.invokingSession.agentSessionId}`
      : ''
  console.log(
    `  "${info.install.exe}" --quit${quitSkipArg}（等价于 File → Exit；等待 ${options.graceSeconds}s，超时不强杀）`,
  )
  console.log(
    `  robocopy "${join(info.main, WIN_UNPACKED_REL)}" "${info.install.dir}" /E /XJ /R:2 /W:1 /NP`,
  )
  console.log(
    `  node "${join(info.main, RUNTIME_RESOURCES_REL)}" verify-packaged "${join(
      info.install.dir,
      'resources',
    )}"`,
  )
  if (options.noRestart) console.log('  （--no-restart：覆盖后不启动）')
  else console.log(`  启动 "${info.install.exe}"（默认 userData）`)
}

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function escapeCmdPath(value) {
  return value.replace(/%/g, '%%')
}

function assertNoRunningWorker() {
  if (!existsSync(RUN_LOCK_FILE)) return
  try {
    const lock = JSON.parse(readFileSync(RUN_LOCK_FILE, 'utf8'))
    if (Number.isInteger(lock.pid) && isPidAlive(lock.pid)) {
      throw new CliError(
        `已有刷新任务在运行（PID ${lock.pid}，日志 ${lock.logFile ?? '未知'}）。请等待完成，或确认无进程后删除 ${RUN_LOCK_FILE}。`,
        3,
      )
    }
  } catch (error) {
    if (error instanceof CliError) throw error
    // 损坏的锁文件视为陈旧，继续覆盖。
  }
}

function writeResult(resultFile, payload) {
  try {
    mkdirSync(dirname(resultFile), { recursive: true })
    writeFileSync(resultFile, JSON.stringify(payload, null, 2))
  } catch {
    // 结果文件只是辅助诊断；写失败不能影响主流程。
  }
}

function createDetachedWorker(options, info) {
  assertNoRunningWorker()
  mkdirSync(RUN_ROOT, { recursive: true })
  const runId = `${formatTimestamp(new Date())}-${process.pid}`
  const runDir = join(RUN_ROOT, runId)
  mkdirSync(runDir, { recursive: true })
  const logFile = join(runDir, 'run.log')
  const configFile = join(runDir, 'config.json')
  const envFile = join(runDir, 'env.json')
  const runCmd = join(runDir, 'run.cmd')
  const resultFile = LAST_RESULT_FILE
  const lockFile = RUN_LOCK_FILE

  const env = { ...process.env }
  delete env.NODE_OPTIONS
  delete env.UNIVERSE_E2E
  delete env.UNIVERSE_USER_DATA_DIR
  delete env.UNIVERSE_CONFIG_DIR
  delete env.UE_ENV
  for (const key of Object.keys(env)) {
    if (/(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i.test(key)) {
      delete env[key]
    }
  }
  writeFileSync(envFile, JSON.stringify(env), { mode: 0o600 })

  const workerArgs = process.argv.slice(2).filter((arg) => arg !== '--foreground')
  workerArgs.push('--main-worktree', info.main, '--install-dir', info.install.dir)
  const invokingSession = resolveInvokingSession()
  writeFileSync(
    configFile,
    JSON.stringify({
      args: workerArgs,
      cwd: process.cwd(),
      logFile,
      envFile,
      resultFile,
      lockFile,
      invokingSession: invokingSession ?? null,
    }),
  )

  const scriptPath = fileURLToPath(import.meta.url)
  const nodeExecPath = process.execPath
  const lines = ['@echo off']
  if (process.versions.electron) lines.push('set ELECTRON_RUN_AS_NODE=1')
  lines.push(
    `"${escapeCmdPath(nodeExecPath)}" "${escapeCmdPath(scriptPath)}" "--worker-config" "${escapeCmdPath(
      configFile,
    )}" >> "${escapeCmdPath(logFile)}" 2>&1`,
  )
  writeFileSync(runCmd, `${lines.join('\r\n')}\r\n`)

  const commandLine = `cmd.exe /d /s /c ""${runCmd}""`
  const ps = [
    '$ErrorActionPreference = "Stop"',
    '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:UE_REFRESH_COMMAND; CurrentDirectory = $env:UE_REFRESH_CWD }',
    'if ($r.ReturnValue -ne 0) { Write-Error "Win32_Process.Create failed: $($r.ReturnValue)"; exit 1 }',
    '[Console]::Out.WriteLine($r.ProcessId)',
  ].join('; ')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      UE_REFRESH_COMMAND: commandLine,
      UE_REFRESH_CWD: process.cwd(),
    },
  })
  if (result.error) {
    throw new CliError(`创建独立后台进程失败: ${result.error.message}`, 9)
  }
  if (result.status !== 0) {
    throw new CliError(
      `创建独立后台进程失败: ${(result.stderr || result.stdout || '').trim()}`,
      9,
    )
  }
  const pid = Number(result.stdout.trim())
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new CliError(`创建独立后台进程失败: WMI 未返回有效 PID（${result.stdout.trim()}）`, 9)
  }
  writeFileSync(lockFile, JSON.stringify({ pid, startedAt: new Date().toISOString(), logFile }))
  return { pid, logFile, resultFile, runDir }
}

async function runWorker(configPath) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  if (config.envFile && existsSync(config.envFile)) {
    Object.assign(process.env, JSON.parse(readFileSync(config.envFile, 'utf8')))
    try {
      unlinkSync(config.envFile)
    } catch {
      // 环境文件残留不影响运行。
    }
  }
  if (config.cwd) {
    try {
      process.chdir(config.cwd)
    } catch {
      // 父进程目录已不可用时，后续流程使用绝对路径。
    }
  }

  const options = parseArgs(config.args)
  options.invokingSession = config.invokingSession ?? resolveInvokingSession()
  let exitCode = 0
  try {
    log('独立 worker 启动，开始预检…')
    const info = preflight(options)
    printPreflightSummary(info)
    if (info.otherSessions.length > 0) {
      throw otherSessionsError(info.otherSessions, '预检时')
    }
    await runFlow(options, info)
    writeResult(config.resultFile, {
      ok: true,
      exitCode: 0,
      message: '完成',
      finishedAt: new Date().toISOString(),
      logFile: config.logFile,
    })
  } catch (error) {
    exitCode = error instanceof CliError ? error.exitCode : 1
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[refresh] ✗ ${message}`)
    writeResult(config.resultFile, {
      ok: false,
      exitCode,
      message,
      finishedAt: new Date().toISOString(),
      logFile: config.logFile,
    })
    process.exitCode = exitCode
  } finally {
    if (config.lockFile) {
      try {
        unlinkSync(config.lockFile)
      } catch {
        // 锁文件可能已被清理。
      }
    }
  }
}

async function runFlow(options, info) {
  let sync = { oldHead: undefined, newHead: undefined }
  if (!options.skipBuild) {
    if (!options.skipPull) {
      log('同步主 worktree…')
      sync = pullMain(info.main)
      updateSubmodules(info.main)
      installDepsIfNeeded(info.main, sync.oldHead, sync.newHead)
    } else {
      warn('--skip-pull：不拉取 main，允许使用主 worktree 当前代码')
      ensureDeps(info.main)
    }
    log('生产构建…')
    buildProduction(info.main, options)
    if (!existsSync(join(info.sourceDir, EXE_NAME))) {
      throw new CliError(`构建后仍缺少 ${EXE_NAME}，打包可能未完成`, 6)
    }
    const builtVersion = readExeVersion(join(info.sourceDir, EXE_NAME))
    log(`构建完成：${builtVersion ?? info.editorVersion}`)
  } else {
    if (!info.sourceExists) {
      throw new CliError(
        `--skip-build 需要现有产物，但缺少 ${join(info.sourceDir, EXE_NAME)}`,
        6,
      )
    }
    warn('--skip-build：跳过同步、依赖安装与构建，复用现有产物')
  }

  // 构建期间可能又开了会话：关闭编辑器前必须重新确认。
  const editorRunning = listInstallProcesses(info.install.dir).length > 0
  const { others: lateOtherSessions } = collectOtherRunningSessions(
    info.install,
    options.invokingSession,
    editorRunning,
  )
  if (lateOtherSessions.length > 0) {
    throw otherSessionsError(lateOtherSessions, '关闭编辑器前')
  }
  log('关闭前会话检查通过')

  log('关闭安装版…')
  const closedCount = await closeInstallProcesses(
    info.install,
    options.invokingSession,
    options.graceSeconds,
  )
  const remaining = listInstallProcesses(info.install.dir)
  if (remaining.length > 0) {
    throw new CliError('关闭后重新检测到安装目录进程，已中止覆盖', 7)
  }

  log('覆盖安装目录…')
  copyBuildToInstall(info.sourceDir, info.install.dir)
  verifyInstalledCopy(info.sourceDir, info.install.dir, info.main)

  const installedVersion = readExeVersion(info.install.exe)
  log(`覆盖完成：安装版版本 ${installedVersion ?? '未知'}，关闭了 ${closedCount} 个进程`)

  if (options.noRestart) {
    log(`--no-restart：未启动编辑器。手动启动: ${info.install.exe}`)
    return
  }

  log('启动安装版编辑器…')
  await launchInstalledEditor(info.install.dir, info.install.exe)
  log('完成')
}

async function main() {
  const workerIndex = process.argv.indexOf('--worker-config')
  if (workerIndex >= 0) {
    const configPath = process.argv[workerIndex + 1]
    if (!configPath) throw new CliError('--worker-config 缺少配置路径', 2)
    await runWorker(configPath)
    return
  }

  const options = parseArgs(process.argv.slice(2))
  if (process.platform !== 'win32') {
    throw new CliError('该 skill 仅支持 Windows（安装版与打包链都是 Windows 专属）', 2)
  }
  options.invokingSession = resolveInvokingSession()

  log('预检…')
  const info = preflight(options)

  if (options.dryRun) {
    printDryRun(options, info)
    return
  }

  printPreflightSummary(info)
  if (info.otherSessions.length > 0) {
    throw otherSessionsError(info.otherSessions, '预检时')
  }
  if (options.foreground) {
    warn(
      '--foreground：脚本在当前进程运行；从编辑器内启动时，编辑器关闭会终止脚本。会话检查照常执行',
    )
    await runFlow(options, info)
    return
  }

  const worker = createDetachedWorker(options, info)
  log('预检通过，已启动独立后台任务。')
  log(`后台进程 PID: ${worker.pid}`)
  log(`日志: ${worker.logFile}`)
  log(`上次结果: ${worker.resultFile}`)
  log('worker 会立即开始同步与构建；关闭编辑器前会再次查询会话。')
  log('无需关闭当前聊天标签页；构建成功后编辑器会自动关闭，本会话会一并结束。')
  log('重新打开编辑器后查看 last-result.json 或日志确认结果。')
}

function printHelp() {
  console.log(`用法: node .claude/skills/refresh-installed-editor/refresh-installed-editor.mjs [选项]

默认流程：前台预检（查询运行中的 agent 会话）-> 启动独立后台 worker ->
拉取主 worktree main、生产打包、关闭前再次查询会话、用 "Universe Editor.exe" --quit
正常关闭编辑器（与 File → Exit 相同的 before-quit/will-quit 管线）、覆盖安装目录并启动编辑器。
worker 通过 WMI 创建，不在编辑器的 Job Object 内，因此编辑器关闭后仍会继续。

会话门禁：除调用本 skill 的会话（按 CLAUDE_CODE_SESSION_ID 识别）外，只要还有
running / ask / background 状态的会话就中止；安装版不支持 --agent-sessions 时直接拒绝。

选项:
  --dry-run              只预检并打印计划，不执行任何写操作
  --foreground           在当前进程直接执行完整流程（编辑器外调试用）
  --skip-build           跳过拉取/依赖/构建，复用现有 win-unpacked
  --skip-pull            不拉取 main，允许主 worktree 有本地改动
  --env <mode>           打包环境，默认 prod（读取 .env.<mode>）
  --strict-notes         不跳过 release notes 发版门禁
  --no-restart           覆盖后不启动编辑器
  --install-dir <path>   安装目录，默认 %LOCALAPPDATA%\\Programs\\Universe Editor
  --main-worktree <path> 主 worktree 路径，默认从 git 自动探测
  --grace-timeout <秒>   等待编辑器正常退出的上限，默认 60；超时不会强杀
  --allow-missing-env    .env.<mode> 缺失时继续
  -h, --help             显示帮助

关闭方式：运行 "Universe Editor.exe" --quit [--quit-skip-session=<id>]（second-instance
转发给主实例，走与 File → Exit 相同的 app.quit() 管线；冷启动时直接退出，不创建窗口）。
从编辑器内调用时自动带上调用会话 id，退出确认只豁免该会话；安装版不支持该参数时
回退为纯 --quit（可能弹一次确认框，更新一次安装版后消失）。`)
}

main().catch((error) => {
  if (error instanceof CliError) {
    console.error(`[refresh] ✗ ${error.message}`)
    process.exit(error.exitCode)
  }
  console.error(error)
  process.exit(1)
})
