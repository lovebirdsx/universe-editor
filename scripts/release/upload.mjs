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
 *  关键顺序（assertPlanConsistency 守护）：安装包 → release-notes 发布包 → 最后 latest.yml。
 *  latest.yml 是 autoUpdater 读的清单，必须等安装包与新下载页内容全部落地后再覆盖，
 *  否则客户端会拉到半包 / 指向 404 的介绍页。共享文件（release-notes.json、notes/index.*、
 *  latest.yml）先传到同目录临时名再原子替换，避免读方看到半截文件。
 *
 *  纯函数部分（parseArgs/resolveUploadConfig/classifyReleaseDir/loadUploadBundle/
 *  buildUploadPlan/assertPlanConsistency/*Command/createExecutor/runUploadPlan）可单测；
 *  执行器注入，dry-run 下不触 ssh/scp。
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
    files.push({ path: artifact.path, src, mode: artifact.mode === 'atomic' ? 'atomic' : 'direct' })
  }
  return { manifest, files }
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
  for (const file of bundle?.files ?? []) {
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
 */
export function assertPlanConsistency({ plan, latestYml, notesVersion, payloads }) {
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
export function createExecutor({ config, sshBase, scpBase, remote, run, warn }) {
  const ssh = (command, opts = {}) =>
    run('ssh', buildSshArgs({ baseArgs: sshBase, remote, command }), {
      timeoutMs: TIMEOUT_MS.ssh,
      ...opts,
    })
  return {
    mkdir: (dir) =>
      ssh(buildRemoteMkdirCommand({ dir, isWindowsTarget: isWindowsTarget(config) }), {
        warnOnly: true,
      }),
    probeShell: () => probeRemoteShellAnswer({ baseArgs: sshBase, remote }),
    probeWrite: (dir) =>
      ssh(buildRemoteProbeCommand({ dir, isWindowsTarget: isWindowsTarget(config) }), {
        timeoutMs: TIMEOUT_MS.probe,
      }),
    upload: (src, remotePath) => {
      // scp 目标写全路径：源文件名带空格也不需要转义，且能落到子目录。
      run('scp', [...scpBase, src, `${remote}:${remotePath}`], { timeoutMs: TIMEOUT_MS.scp })
    },
    move: (tmp, targetPath) =>
      ssh(
        buildRemoteReplaceCommand({
          tempPath: tmp,
          targetPath,
          isWindowsTarget: isWindowsTarget(config),
        }),
      ),
    /**
     * The fallback is cmd syntax, so it only makes sense on a Windows target. On POSIX a
     * failed `mv` is a permission/path problem; running a command that cannot exist there
     * would replace the real cause with a confusing "cmd: not found".
     */
    moveFallback: (tmp, targetPath, cause) => {
      if (!isWindowsTarget(config)) {
        throw cause instanceof Error ? cause : new Error(`原子替换失败：${targetPath}`)
      }
      warn(`原子替换失败，退化 copy /Y + del：${targetPath}`)
      return ssh(buildRemoteReplaceFallback({ tempPath: tmp, targetPath }))
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
    const printable = `${cmd} ${cmdArgs.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`
    if (dryRun) {
      log(`  [dry-run] ${printable}`)
      return
    }
    const res = spawn(cmd, cmdArgs, { stdio: 'inherit', timeout: opts.timeoutMs })
    const failure = res.error
      ? `执行失败: ${printable}\n  ${res.error.message}`
      : res.status === null
        ? `命令被信号终止 (${res.signal}): ${printable}`
        : res.status !== 0
          ? `命令返回非零退出码 (${res.status}): ${printable}`
          : undefined
    if (!failure) return
    if (opts.warnOnly) return warnFn(failure)
    throw new Error(failure)
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

  const plan = buildUploadPlan({ payloads, manifests, bundle })
  const latestYml = readLatestYml()
  let version
  try {
    ;({ version } = assertPlanConsistency({
      plan,
      latestYml,
      notesVersion: bundle.manifest.version,
      payloads,
    }))
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

  console.log(`\n📦 Universe Editor ${version} → ${remote}:${config.dir}`)
  console.log(`   产物: ${plan.map((step) => step.label).join(', ')}`)
  console.log(config.dryRun ? '   (dry-run，不实际上传)\n' : '')

  const nonce = `${process.pid}`
  const executor = createExecutor({ config, sshBase, scpBase, remote, run, warn })

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
