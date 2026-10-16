#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  把 apps/editor/release/ 下的更新产物 + release-notes 上传发布包同步到静态服务器。
 *
 *  用法（在仓库根目录）:
 *    node scripts/release/upload.mjs --host 192.0.2.10 --user deploy --dir /srv/universe-editor
 *  或用环境变量:
 *    UE_RELEASE_HOST=192.0.2.10 UE_RELEASE_USER=deploy UE_RELEASE_DIR=/srv/universe-editor \
 *      node scripts/release/upload.mjs
 *
 *  底层用系统自带的 ssh / scp（Windows 10+ 与 Ubuntu 均内置 OpenSSH），无第三方依赖。
 *
 *  关键顺序（assertPlanConsistency 守护）：安装包 → release-notes 发布包（版本页 → 索引）→
 *  最后 latest.yml。latest.yml 是 autoUpdater 读的清单，必须等安装包与新下载页内容全部落地后
 *  再覆盖，否则客户端会拉到半包 / 指向 404 的介绍页。共享文件（release-notes.json、
 *  notes/index.*、latest.yml）先传到同目录临时名再原子替换，避免读方看到半截文件；版本页必须
 *  排在 notes/index.* 之前——索引页链接每一张版本页，先换索引就等于先留下一屏死链。
 *
 *  增量补缺（resolveNotesUpload）：上传前用一次 ssh 列远端 notes/，只有 manifest 标了 requiredUpload
 *  的必传页（本版内容落在的页 + 被补丁并稿的页）与共享文件必传，其余版本页在远端已有同名文件时跳过
 *  （首装 / 换 --dir 自动补齐历史页）；--all-notes 强制全量。列目录失败 / 输出不可解析 / 发布包没有
 *  必传标记一律退回「全传」——探测失败绝不导致少传，少传的后果是索引页死链。
 *
 *  纯函数部分（parseArgs/resolveUploadConfig/classifyReleaseDir/loadUploadBundle/buildUploadPlan/
 *  assertPlanConsistency/resolveNotesUpload/parseRemoteNoteNames/*Command/createExecutor/
 *  runUploadPlan）可单测；执行器注入，dry-run 下不触 ssh/scp。
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from '../lib/env.mjs'
import {
  buildSshArgs,
  CMD_SHELL_FIX_HINT,
  CMD_SHELL_PROBE,
  isCmdExeShell,
  probeRemoteShellAnswer,
} from '../server/remoteShell.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')
const releaseDir = join(repoRoot, 'apps', 'editor', 'release')
const notesBundleDir = join(releaseDir, 'release-notes')

const TIMEOUT_MS = { probe: 15000, ssh: 60000, scp: 600000 }

export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    // `pnpm release:upload -- --host …` forwards the separator verbatim (pnpm 11).
    if (a === '--') continue
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

/** Merge CLI flags with UE_RELEASE_* env; returns the config plus every missing field. */
export function resolveUploadConfig(args, env = process.env) {
  const config = {
    host: args.host ?? env.UE_RELEASE_HOST,
    user: args.user ?? env.UE_RELEASE_USER,
    dir: args.dir ?? env.UE_RELEASE_DIR,
    port: args.port ?? env.UE_RELEASE_PORT ?? '22',
    key: args.key ?? env.UE_RELEASE_KEY,
    remoteOs: args['remote-os'] ?? env.UE_RELEASE_OS,
    dryRun: args.dryRun ?? false,
    mkdir: args.mkdir ?? true,
    allNotes: args['all-notes'] ?? false,
  }
  const missing = []
  if (!config.host) missing.push('--host（或 UE_RELEASE_HOST）')
  if (!config.user) missing.push('--user（或 UE_RELEASE_USER）')
  if (!config.dir) missing.push('--dir（或 UE_RELEASE_DIR），即服务器上的目标目录')
  // 去掉尾部分隔符，避免拼出 D:\universe-editor\/ 这种脏路径。
  if (config.dir) config.dir = config.dir.replace(/[\\/]+$/, '')
  return { config, missing, isWindowsTarget: isWindowsTarget(config) }
}

/** 远端是 Windows 还是类 Unix：决定 mkdir / 替换用什么命令。 */
export function isWindowsTarget(config) {
  if (config.remoteOs === 'windows') return true
  if (config.remoteOs === 'linux') return false
  return /^[A-Za-z]:[\\/]/.test(config.dir ?? '') || (config.dir ?? '').includes('\\')
}

/**
 * Split the release dir into what must be uploaded, in an explicit order (readdir order
 * varies by platform). `latest.yml` is separated because it is the gate for autoUpdater.
 */
export function classifyReleaseDir(entries) {
  const sorted = [...entries].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return {
    payloads: sorted.filter((f) => f.endsWith('.exe') || f.endsWith('.blockmap')),
    manifests: sorted.filter((f) => f === 'latest.yml'),
  }
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Read the compiled upload bundle (apps/editor/release/release-notes) and verify every
 * artifact against the manifest before a single byte leaves the machine.
 */
export function loadUploadBundle({ bundleDir = notesBundleDir } = {}) {
  const manifestPath = join(bundleDir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new Error(
      `缺少 release notes 上传包 ${bundleDir}；打包链应生成它（node scripts/release/release-notes/compile.mjs --bundle <dir>）`,
    )
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const files = []
  for (const artifact of manifest.artifacts ?? []) {
    if (!artifact.upload) continue
    const src = join(bundleDir, ...artifact.path.split('/'))
    if (!existsSync(src)) throw new Error(`上传包缺少产物 ${artifact.path}（${src}）`)
    const actual = sha256File(src)
    if (actual !== artifact.sha256) {
      throw new Error(
        `上传包产物 ${artifact.path} 与 manifest 哈希不符（${actual} ≠ ${artifact.sha256}）`,
      )
    }
    if (statSync(src).size !== artifact.bytes) {
      throw new Error(`上传包产物 ${artifact.path} 字节数与 manifest 不符`)
    }
    files.push({
      path: artifact.path,
      src,
      mode: artifact.mode === 'atomic' ? 'atomic' : 'direct',
      // compile.mjs 给「本版必须重传的版本页」打标（本版内容落在的页 + 被补丁并稿的页）；
      // 字段缺失（旧发布包）即无从判断，调用方据此退回全量。
      requiredUpload: artifact.requiredUpload === true,
    })
  }
  return { manifest, files }
}

/** 每版介绍页在发布包里的路径形态——唯一可增量的产物。 */
export function isNotePagePath(path) {
  return /^notes\/v[^/]+\.html$/.test(path)
}

function isNoteIndexPath(path) {
  return path === 'notes/index.json' || path === 'notes/index.html'
}

/**
 * 版本页排到索引之前：notes/index.* 链接每一张版本页，索引先落地而进程中途失败，站点就会
 * 长期指向不存在的页面。release-notes.json 不含页面链接，保持最前。
 */
export function orderNotesFiles(files) {
  const pages = files.filter((file) => isNotePagePath(file.path))
  const indexes = files.filter((file) => isNoteIndexPath(file.path))
  const rest = files.filter((file) => !isNotePagePath(file.path) && !isNoteIndexPath(file.path))
  return [...rest, ...pages, ...indexes]
}

/**
 * 决定 notes 阶段传哪些文件。必传页（manifest 标 requiredUpload）与共享文件永远传；其余版本页在
 * 远端已有同名文件时跳过。三种情况一律退回「全量」：--all-notes、远端未知（探测失败 / dry-run）、
 * 发布包没标出必传页（旧 manifest，或本版内容没落到任何页上）。
 */
export function resolveNotesUpload({
  files,
  allNotes = false,
  listNoteNames,
  warn: warnFn = warn,
}) {
  const requiredPaths = files
    .filter((file) => file.requiredUpload === true)
    .map((file) => file.path)
  const keepAll = (source) => ({ files: [...files], skipped: [], requiredPaths, source })
  if (allNotes) return keepAll('all')
  if (requiredPaths.length === 0) {
    warnFn('发布包没有标出必传页（manifest 缺少 requiredUpload 标记）；本次全量上传历史页面')
    return keepAll('unknown')
  }
  const remoteNames = listNoteNames()
  if (remoteNames === null || remoteNames === undefined) return keepAll('unknown')
  const kept = []
  const skipped = []
  for (const file of files) {
    const name = isNotePagePath(file.path) ? file.path.slice('notes/'.length) : ''
    // 必传页无条件传：远端「已有」不代表内容对（补丁并稿、模板刷新、上一次半截上传）。
    if (name !== '' && file.requiredUpload !== true && remoteNames.has(name))
      skipped.push(file.path)
    else kept.push(file)
  }
  return { files: kept, skipped, requiredPaths, source: 'incremental' }
}

/**
 * Build the upload plan: installer payloads, then the release-notes bundle, then latest.yml.
 * Every entry carries where it lands relative to `config.dir` so a test can assert the
 * order, the remote paths and the atomic/direct mode without touching ssh.
 */
export function buildUploadPlan({ payloads, manifests, bundle }) {
  const steps = []
  for (const file of payloads) {
    steps.push({
      phase: 'payload',
      mode: 'direct',
      label: file,
      src: join(releaseDir, file),
      remotePath: file,
    })
  }
  for (const file of orderNotesFiles(bundle?.files ?? [])) {
    steps.push({
      phase: 'notes',
      mode: file.mode,
      label: file.path,
      src: file.src,
      remotePath: file.path.split('/').join('/'),
    })
  }
  for (const file of manifests) {
    // autoUpdater 只读这一个清单：原子替换，且必须是最后一步。
    steps.push({
      phase: 'manifest',
      mode: 'atomic',
      label: file,
      src: join(releaseDir, file),
      remotePath: file,
    })
  }
  return steps
}

/** Directories the notes bundle needs on the remote (`notes/` for the per-version pages). */
export function remoteDirs(plan) {
  const dirs = new Set()
  for (const step of plan) {
    const slash = step.remotePath.lastIndexOf('/')
    if (slash > 0) dirs.add(step.remotePath.slice(0, slash))
  }
  return [...dirs].sort()
}

/**
 * Refuse to upload an inconsistent set: the notes bundle must describe the same version as
 * latest.yml, latest.yml must be last, and its `path:` must be one of the payloads we are
 * about to ship — otherwise clients would be pointed at a file that never lands.
 *
 * notes 段内部还要求「版本页在索引之前、必传页一张都不少」，于是整条计划是一个两段式
 * 单调序：{安装包, 版本页} → {notes/index.*} → {latest.yml}。
 */
export function assertPlanConsistency({
  plan,
  latestYml,
  notesVersion,
  payloads,
  requiredPaths = [],
}) {
  if (plan.length === 0) throw new Error('上传计划为空：release/ 下没有可上传的产物')
  const last = plan[plan.length - 1]
  if (last.phase !== 'manifest' || last.label !== 'latest.yml') {
    throw new Error('latest.yml 必须是上传计划的最后一步（否则客户端可能读到指向半包的清单）')
  }
  if (!latestYml.version) throw new Error('latest.yml 缺少 version 字段')
  if (notesVersion !== undefined && notesVersion !== latestYml.version) {
    throw new Error(
      `release notes 发布包版本 ${notesVersion} 与 latest.yml 的 ${latestYml.version} 不一致；` +
        '请重新打包，不要混用两次构建的产物',
    )
  }
  if (latestYml.path && !payloads.includes(latestYml.path)) {
    throw new Error(`latest.yml 指向 ${latestYml.path}，但 release/ 下没有这个产物`)
  }
  // 增量过滤只允许减少历史版本页；必传页被过滤掉就是「内容静默不更新」，必须当场失败。
  for (const path of requiredPaths) {
    if (!plan.some((step) => step.remotePath === path)) {
      throw new Error(`必传版本页 ${path} 不在上传计划里（增量过滤丢掉了本版必传页面）`)
    }
  }
  const lastPage = plan.reduce(
    (acc, step, index) => (isNotePagePath(step.remotePath) ? index : acc),
    -1,
  )
  const firstIndex = plan.findIndex((step) => isNoteIndexPath(step.remotePath))
  if (firstIndex >= 0 && lastPage > firstIndex) {
    throw new Error('版本页必须排在 notes/index.* 之前（索引页链接全部版本页，先换索引会留下死链）')
  }
  return { version: latestYml.version }
}

/** Same-directory temp name so the later move is a rename, not a cross-device copy. */
export function tempRemotePath(targetPath, nonce) {
  const slash = Math.max(targetPath.lastIndexOf('/'), targetPath.lastIndexOf('\\'))
  const dir = slash > 0 ? targetPath.slice(0, slash + 1) : ''
  const name = slash > 0 ? targetPath.slice(slash + 1) : targetPath
  return `${dir}.ue-tmp-${nonce}-${name}`
}

export function buildRemoteMkdirCommand({ dir, isWindowsTarget }) {
  // Windows 远端用 cmd /c 包裹：无论默认 shell 是 cmd 还是 PowerShell 都能跑，if not exist 保证幂等。
  return isWindowsTarget ? `cmd /c if not exist "${dir}" md "${dir}"` : `mkdir -p '${dir}'`
}

export function buildRemoteProbeCommand({ dir, isWindowsTarget }) {
  const probe = isWindowsTarget ? `${dir}\\.ue-write-probe` : `${dir}/.ue-write-probe`
  return isWindowsTarget
    ? `cmd /c type nul > "${probe}" && del "${probe}"`
    : `touch '${probe}' && rm -f '${probe}'`
}

/**
 * 列远端目录里的文件名（增量补缺的唯一探测）。`ls -1p` / `dir /b /a-d` 都只回文件名、不带
 * 子目录条目；目录不存在时两者都是非零退出码，调用方据此降级，不去匹配报错文本——Windows 的
 * 报错文案随系统语言变。`dir` 由调用方拼好（含 --dir，已去尾分隔符）：这里**不要**再补分隔符，
 * `"D:\site\"` 会踩 cmd 吃引号的坑。
 */
export function buildRemoteListCommand({ dir, isWindowsTarget }) {
  return isWindowsTarget ? `cmd /c dir /b /a-d "${dir}"` : `ls -1p '${dir}'`
}

const REMOTE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MAX_REMOTE_NAME_LENGTH = 128

/**
 * 把列表命令的 stdout 解析成文件名集合；任何一行不像裸文件名就让整次解析作废（null）。
 * 少信一次输出只是多传页面，误信一行却会让索引页留下死链。空输出是合法结果（目录存在但为空）。
 * 点文件（我们自己的 `.ue-tmp-*` 残留、`.DS_Store` 之类）直接忽略：页面名一律以 `v` 开头，
 * 忽略它们不可能漏掉真页面，却能让一次中断留下的临时文件不至于永久拖累成「每次全量」。
 * 名字逐字节比对、**不做大小写折叠**：两侧都出自同一份 manifest，而折叠在大小写敏感的
 * Linux 目标上是错的方向（远端真有 V0.15.0.HTML 时折叠会让我们跳过 v0.15.0.html）。
 */
export function parseRemoteNoteNames(stdout) {
  if (typeof stdout !== 'string') return null
  const names = new Set()
  for (const rawLine of stdout.split('\n')) {
    // cmd 回显 CRLF；只剥行尾的 \r，不用 trim——前后有空白说明这行不是裸文件名。
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') continue
    if (line !== line.trim()) return null
    if (line.startsWith('.')) continue
    if (line.endsWith('/') || line.endsWith('\\')) continue
    if (line.length > MAX_REMOTE_NAME_LENGTH || !REMOTE_NAME_RE.test(line)) return null
    names.add(line)
  }
  return names
}

/**
 * 上传前一次性枚举远端 notes/。返回文件名集合，或 null 表示「远端未知」（dry-run、ssh 失败、
 * 输出不可解析）——调用方在未知时必须上传全部页面。
 */
export function listRemoteNoteNames({ executor, target = 'notes', warn: warnFn = warn }) {
  let stdout
  try {
    stdout = executor.listDir(target)
  } catch (error) {
    warnFn(
      `远端 ${target}/ 列目录失败（${error instanceof Error ? error.message : String(error)}）；` +
        '本次全量上传历史页面（首装 / 换 --dir 属正常，持续出现请检查目录对发布账号是否可读）',
    )
    return null
  }
  if (stdout === null || stdout === undefined) return null
  const names = parseRemoteNoteNames(stdout)
  if (names === null) {
    warnFn(`远端 ${target}/ 列目录输出无法解析（目录里可能混入了非本站文件）；本次全量上传历史页面`)
    return null
  }
  return names
}

export function buildRemoteReplaceCommand({ tempPath, targetPath, isWindowsTarget }) {
  if (!isWindowsTarget) return `mv -f '${tempPath}' '${targetPath}'`
  // move /Y 覆盖已存在文件；个别 Windows/杀软组合下 move 到被读文件会失败，退化 copy /Y + del。
  return `cmd /c move /Y "${tempPath}" "${targetPath}"`
}

export function buildRemoteReplaceFallback({ tempPath, targetPath }) {
  return `cmd /c copy /Y "${tempPath}" "${targetPath}" && del "${tempPath}"`
}

/**
 * Executor: the only place that talks to ssh/scp. Injected so the plan/order logic above
 * stays testable; `run` is what tests replace.
 */
export function createExecutor({ config, sshBase, scpBase, remote, run, capture, warn }) {
  const dir = (config.dir ?? '').replace(/[\\/]+$/, '')
  const isWin = isWindowsTarget(config)
  // plan 里的远端路径一律相对 --dir；scp / mv 收到相对路径会落在远端用户 home（2026-10 发版事故）。
  const scpPath = (path) => (dir ? `${dir}/${path}` : path)
  // cmd 命令整条路径用 `\`（plan 里的 `/` 一并转换），scp 用 `/`（Windows 远端同样接受）。
  const cmdPath = (path) => {
    const win = isWin ? path.replace(/\//g, '\\') : path
    return dir ? `${dir}${isWin ? '\\' : '/'}${win}` : win
  }
  const ssh = (command, opts = {}) =>
    run('ssh', buildSshArgs({ baseArgs: sshBase, remote, command }), {
      timeoutMs: TIMEOUT_MS.ssh,
      ...opts,
    })
  const captureSsh = (command, opts = {}) =>
    capture('ssh', buildSshArgs({ baseArgs: sshBase, remote, command }), {
      timeoutMs: TIMEOUT_MS.probe,
      ...opts,
    })
  return {
    mkdir: (target) =>
      ssh(buildRemoteMkdirCommand({ dir: target, isWindowsTarget: isWin }), { warnOnly: true }),
    probeShell: () => probeRemoteShellAnswer({ baseArgs: sshBase, remote }),
    probeWrite: (target) =>
      ssh(buildRemoteProbeCommand({ dir: target, isWindowsTarget: isWin }), {
        timeoutMs: TIMEOUT_MS.probe,
      }),
    /**
     * 唯一需要读 stdout 的命令（列目录），故走 capture 而不是 run。
     * `target` 与 upload/move 一样是相对 --dir 的路径（如 `notes`），在这里拼成绝对路径。
     */
    listDir: (target) =>
      captureSsh(buildRemoteListCommand({ dir: cmdPath(target), isWindowsTarget: isWin })),
    upload: (src, path) => {
      // scp 目标写绝对路径：源文件名带空格也不需要转义，且能落到子目录。
      run('scp', [...scpBase, src, `${remote}:${scpPath(path)}`], { timeoutMs: TIMEOUT_MS.scp })
    },
    move: (tmp, targetPath) =>
      ssh(
        buildRemoteReplaceCommand({
          tempPath: cmdPath(tmp),
          targetPath: cmdPath(targetPath),
          isWindowsTarget: isWin,
        }),
      ),
    /**
     * The fallback is cmd syntax, so it only makes sense on a Windows target. On POSIX a
     * failed `mv` is a permission/path problem; running a command that cannot exist there
     * would replace the real cause with a confusing "cmd: not found".
     */
    moveFallback: (tmp, targetPath, cause) => {
      if (!isWin) {
        throw cause instanceof Error ? cause : new Error(`原子替换失败：${targetPath}`)
      }
      warn(`原子替换失败，退化 copy /Y + del：${targetPath}`)
      return ssh(
        buildRemoteReplaceFallback({ tempPath: cmdPath(tmp), targetPath: cmdPath(targetPath) }),
      )
    },
  }
}

/**
 * Run the plan. Any failure throws before the next step — in particular nothing can reach
 * the final `latest.yml` step, so a partial upload never becomes the advertised release.
 */
export function runUploadPlan(plan, executor, { log = () => {}, nonce = '0' } = {}) {
  for (const step of plan) {
    if (step.mode !== 'atomic') {
      log(`⬆️  ${step.label}`)
      executor.upload(step.src, step.remotePath)
      continue
    }
    const tmp = tempRemotePath(step.remotePath, nonce)
    log(`⬆️  ${step.label}（先临时文件，再原子替换）`)
    executor.upload(step.src, tmp)
    try {
      executor.move(tmp, step.remotePath)
    } catch (error) {
      // Hand the cause down: a target that cannot fall back must rethrow it as-is.
      executor.moveFallback(tmp, step.remotePath, error)
    }
  }
}

function die(msg) {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`)
  process.exit(1)
}

function warn(msg) {
  console.warn(`\x1b[33m⚠ ${msg}\x1b[0m`)
}

function readLatestYml() {
  const path = join(releaseDir, 'latest.yml')
  const text = readFileSync(path, 'utf8')
  const version = text.match(/^version:\s*(.+)$/m)?.[1]?.trim() ?? ''
  const file = text.match(/^path:\s*(.+)$/m)?.[1]?.trim() ?? ''
  return { version, path: file }
}

function printableCommand(cmd, cmdArgs) {
  return `${cmd} ${cmdArgs.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`
}

/** 两个 runner 共用的失败描述；成功返回 undefined。文案只此一份，别让两边走偏。 */
function spawnFailure(res, printable) {
  if (res.error) return `执行失败: ${printable}\n  ${res.error.message}`
  if (res.status === null) return `命令被信号终止 (${res.signal}): ${printable}`
  if (res.status !== 0) return `命令返回非零退出码 (${res.status}): ${printable}`
  return undefined
}

/**
 * The only spawn site. Dry-run prints and returns without spawning; a warnOnly failure is
 * reported and swallowed (mkdir / fallback moves), everything else throws so the plan stops
 * before the next — and never reaches the closing latest.yml step.
 */
export function createRunner({
  dryRun = false,
  spawn = spawnSync,
  warn: warnFn = warn,
  log = console.log,
} = {}) {
  return (cmd, cmdArgs, opts = {}) => {
    const printable = printableCommand(cmd, cmdArgs)
    if (dryRun) {
      log(`  [dry-run] ${printable}`)
      return
    }
    const res = spawn(cmd, cmdArgs, { stdio: 'inherit', timeout: opts.timeoutMs })
    const failure = spawnFailure(res, printable)
    if (!failure) return
    if (opts.warnOnly) return warnFn(failure)
    throw new Error(failure)
  }
}

/**
 * Same shape as createRunner but returns stdout (that one inherits stdio to keep scp output
 * live). Dry-run prints and returns null — "远端未知", so the caller plans the full upload
 * instead of guessing.
 */
export function createCaptureRunner({ dryRun = false, spawn = spawnSync, log = console.log } = {}) {
  return (cmd, cmdArgs, opts = {}) => {
    const printable = printableCommand(cmd, cmdArgs)
    if (dryRun) {
      log(`  [dry-run] ${printable}`)
      return null
    }
    const res = spawn(cmd, cmdArgs, {
      encoding: 'utf8',
      timeout: opts.timeoutMs,
      maxBuffer: 1 << 20,
    })
    const failure = spawnFailure(res, printable)
    if (failure) throw new Error(failure)
    return res.stdout ?? ''
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const { config, missing, isWindowsTarget: windowsTarget } = resolveUploadConfig(args)
  if (missing.length > 0) die(`缺少参数：${missing.join('、')}`)
  if (!existsSync(releaseDir)) {
    die(`找不到产物目录: ${releaseDir}\n  先跑 pnpm --filter @universe-editor/editor package:win`)
  }

  const { payloads, manifests } = classifyReleaseDir(readdirSync(releaseDir))
  if (manifests.length === 0) {
    die('release/ 下没有 latest.yml；确认 electron-builder.yml 已配 publish 且打包成功')
  }
  if (payloads.length === 0) die('release/ 下没有 .exe / .blockmap 产物')

  let bundle
  try {
    bundle = loadUploadBundle({})
  } catch (error) {
    die(error instanceof Error ? error.message : String(error))
  }

  const remote = `${config.user}@${config.host}`
  const sshBase = ['-p', config.port]
  const scpBase = ['-P', config.port]
  if (config.key) {
    sshBase.push('-i', config.key)
    scpBase.push('-i', config.key)
  }

  const run = createRunner({ dryRun: config.dryRun })
  const capture = createCaptureRunner({ dryRun: config.dryRun })
  const nonce = `${process.pid}`
  const executor = createExecutor({ config, sshBase, scpBase, remote, run, capture, warn })

  if (windowsTarget) {
    // Windows 远端命令全是 cmd 语法（不做 cmd/PowerShell 兼容封装，理由见 remoteShell.mjs）。
    if (!config.dryRun) {
      const answer = executor.probeShell()
      if (!isCmdExeShell(answer) && answer !== null) {
        die(
          `远端 OpenSSH 默认 shell 不是 cmd.exe（${CMD_SHELL_PROBE} 回显: "${answer}"）\n  ${CMD_SHELL_FIX_HINT}`,
        )
      }
    } else {
      console.log(`  [dry-run] ssh ${remote} "${CMD_SHELL_PROBE}"   # 探测远端默认 shell`)
    }
  }

  // 增量补缺：列一次远端 notes/（早于 mkdir——首装目录还不存在，会告警并按全量传，结果正确）。
  // --all-notes 时 listNoteNames 根本不会被调用，一条 ssh 都不发。
  const notes = resolveNotesUpload({
    files: bundle.files,
    allNotes: config.allNotes,
    listNoteNames: () => listRemoteNoteNames({ executor, warn }),
    warn,
  })

  const plan = buildUploadPlan({
    payloads,
    manifests,
    bundle: { manifest: bundle.manifest, files: notes.files },
  })
  const latestYml = readLatestYml()
  let version
  try {
    ;({ version } = assertPlanConsistency({
      plan,
      latestYml,
      notesVersion: bundle.manifest.version,
      payloads,
      requiredPaths: notes.requiredPaths,
    }))
  } catch (error) {
    die(error instanceof Error ? error.message : String(error))
  }

  const reason =
    notes.source === 'all'
      ? '（--all-notes：强制全量重传）'
      : notes.source === 'unknown'
        ? '（远端未知：全量上传）'
        : notes.skipped.length > 0
          ? `（跳过 ${notes.skipped.length} 个远端已有的历史页；--all-notes 可强制全量）`
          : ''
  console.log(`\n📦 Universe Editor ${version} → ${remote}:${config.dir}`)
  console.log(`   产物: ${plan.map((step) => step.label).join(', ')}`)
  console.log(
    `   版本页: ${plan.filter((step) => isNotePagePath(step.remotePath)).length} 个${reason}`,
  )
  console.log(config.dryRun ? '   (dry-run，不实际上传)\n' : '')

  try {
    if (config.mkdir) {
      // mkdir 失败仅告警不退出，避免「目录已存在」等无害情形阻断上传。
      executor.mkdir(config.dir)
      for (const dir of remoteDirs(plan)) executor.mkdir(`${config.dir}/${dir}`)
    }

    // 上传前预检：用临时探针文件确认目标目录可写。否则要等 scp 半路 Permission denied
    // 才暴露权限问题，错误信息既晚又不直观（目录通常是 root 建的，user 进得去写不了）。
    if (!config.dryRun) {
      try {
        executor.probeWrite(config.dir)
      } catch (error) {
        die(
          `目标目录不可写：${config.user} 对 ${config.dir} 没有写权限。\n` +
            `  ${error instanceof Error ? error.message : String(error)}\n` +
            `  在服务器上用 root/sudo 执行其一后重试：\n` +
            `    sudo chown -R ${config.user} ${config.dir}\n` +
            `    sudo chmod -R 0775 ${config.dir}\n` +
            `  新版首装会自动为发布用户开通组写：重跑 pnpm server:setup -- --env <mode> --force 即可补齐。\n` +
            `  或改用 ${config.user} 有写权限的目录（--dir）。`,
        )
      }
    }

    runUploadPlan(plan, executor, { log: (line) => console.log(line), nonce })
  } catch (error) {
    die(error instanceof Error ? error.message : String(error))
  }

  console.log(
    `\n\x1b[32m✓ 完成。客户端将在下次检查时从 ${config.dir}/latest.yml 发现 ${version}\x1b[0m\n`,
  )
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  loadEnv()
  main()
}
