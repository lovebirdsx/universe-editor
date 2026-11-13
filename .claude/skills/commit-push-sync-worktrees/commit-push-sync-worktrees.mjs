#!/usr/bin/env node
/**
 * commit-push-sync-worktrees — 提交当前 worktree 的改动，把当前分支相对 main 的提交
 * cherry-pick 到 main，推送 origin/main，再把所有其它 worktree 同步到 main。
 *
 * 安全不变量：不 force push、不 stash、不 clean、不自动提交其它 worktree；
 * main 持有者脏则中止；cherry-pick 冲突时 abort，main 保持原状。
 *
 * 同步语义复刻编辑器 Git Graph 的「Sync worktrees to main…」非 force 模式：
 * 脏/进行中操作跳过；只有 main..HEAD 的每个 subject 都已在 main 自 merge-base
 * 以来的历史中，才 reset --hard main。
 */

import { spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'

const TARGET_BRANCH = 'main'
const REMOTE = 'origin'
const LOCK_STALE_MS = 30 * 60 * 1000
const GIT_TIMEOUT_MS = 120_000
const FETCH_TIMEOUT_MS = 180_000
const PUSH_TIMEOUT_MS = 300_000
const SUBMODULE_TIMEOUT_MS = 600_000

const PENDING_MARKERS = [
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase/am'],
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect'],
]

const COMMIT_TYPES = new Set([
  'feat',
  'fix',
  'perf',
  'refactor',
  'docs',
  'style',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
  'security',
])

class SyncError extends Error {}

const log = (msg) => console.log(`[sync] ${msg}`)
const warn = (msg) => console.warn(`[sync] 警告: ${msg}`)

function fail(msg) {
  throw new SyncError(msg)
}

function short(sha) {
  return sha ? sha.slice(0, 8) : '(unknown)'
}

function firstLine(text) {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? ''
}

function gitErrorText(res) {
  return res.stderr.trim() || res.stdout.trim() || `git exited with code ${res.status}`
}

function runGit(args, { cwd, timeout = GIT_TIMEOUT_MS } = {}) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  if (res.error) {
    if (res.error.code === 'ETIMEDOUT') fail(`git ${args.join(' ')} 超时（${timeout}ms）`)
    fail(`无法执行 git: ${res.error.message}`)
  }
  return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

function git(args, options) {
  const res = runGit(args, options)
  if (res.status !== 0) fail(`git ${args.join(' ')} 失败: ${gitErrorText(res)}`)
  return res.stdout
}

function gitMaybe(args, options) {
  return runGit(args, options)
}

function normalizePath(p) {
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[a-zA-Z]:/.test(s)) s = `${s[0].toLowerCase()}${s.slice(1)}`
  return s
}

function canonicalPath(p) {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

function samePath(a, b) {
  const x = normalizePath(canonicalPath(a))
  const y = normalizePath(canonicalPath(b))
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

function parseWorktreesZ(stdout) {
  const result = []
  let current

  const flush = () => {
    if (current) {
      result.push(current)
      current = undefined
    }
  }

  for (const token of stdout.split('\0')) {
    if (token === '') {
      flush()
      continue
    }
    const sep = token.indexOf(' ')
    const key = sep === -1 ? token : token.slice(0, sep)
    const value = sep === -1 ? '' : token.slice(sep + 1)
    if (key === 'worktree') {
      flush()
      current = { path: value, branch: undefined, head: undefined, bare: false, detached: false }
      continue
    }
    if (!current) continue
    if (key === 'HEAD') current.head = value
    else if (key === 'branch') {
      current.branch = value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value
    } else if (key === 'bare') current.bare = true
    else if (key === 'detached') current.detached = true
  }

  flush()
  return result
}

function listWorktrees(cwd) {
  return parseWorktreesZ(git(['worktree', 'list', '--porcelain', '-z'], { cwd }))
}

function pendingOperation(path) {
  for (const [marker, label] of PENDING_MARKERS) {
    const res = gitMaybe(['rev-parse', '--git-path', marker], { cwd: path })
    if (res.status !== 0) continue
    const markerPath = res.stdout.trim()
    if (!markerPath) continue
    const full = isAbsolute(markerPath) ? markerPath : resolve(path, markerPath)
    if (existsSync(full)) return label
  }
  return undefined
}

function resolveContext() {
  const inside = gitMaybe(['rev-parse', '--is-inside-work-tree'], { cwd: process.cwd() })
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    fail('当前目录不在 git worktree 内')
  }

  const superproject = gitMaybe(['rev-parse', '--show-superproject-working-tree'], {
    cwd: process.cwd(),
  })
  if (superproject.status === 0 && superproject.stdout.trim()) {
    fail('当前目录属于 submodule，请在父仓库中运行')
  }

  const top = git(['rev-parse', '--show-toplevel'], { cwd: process.cwd() }).trim()
  const commonRaw = git(['rev-parse', '--git-common-dir'], { cwd: top }).trim()
  const commonDir = isAbsolute(commonRaw) ? commonRaw : resolve(top, commonRaw)

  const origin = gitMaybe(['remote', 'get-url', REMOTE], { cwd: top })
  if (origin.status !== 0 || !origin.stdout.trim()) fail(`未配置 ${REMOTE} 远端`)

  const branch = gitMaybe(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: top }).stdout.trim()
  if (!branch) fail('当前 worktree 处于 detached HEAD；请先切到分支')

  const worktrees = listWorktrees(top)
  if (worktrees.length === 0) fail('未找到任何 worktree')

  const current = worktrees.find((wt) => samePath(wt.path, top))
  if (!current) fail(`无法在 worktree 列表中定位当前目录: ${top}`)

  const mainHolder = worktrees.find((wt) => !wt.bare && wt.branch === TARGET_BRANCH)
  return { top, commonDir, branch, worktrees, current, mainHolder }
}

function lockIsStale(lockPath) {
  try {
    const data = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (typeof data.pid !== 'number' || typeof data.startedAt !== 'number') return true
    if (Date.now() - data.startedAt > LOCK_STALE_MS) return true
    try {
      process.kill(data.pid, 0)
      return false
    } catch (err) {
      return err.code === 'ESRCH'
    }
  } catch {
    return true
  }
}

function acquireLock(commonDir) {
  const lockPath = join(commonDir, 'commit-push-sync.lock')
  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: Date.now(),
    cwd: process.cwd(),
  })

  for (let attempt = 0; attempt < 2; attempt++) {
    let fd
    try {
      fd = openSync(lockPath, 'wx')
      writeFileSync(fd, payload, 'utf8')
      closeSync(fd)
      fd = undefined
      return { path: lockPath, payload }
    } catch (err) {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          // fd 已关闭或不可用
        }
      }
      if (err.code !== 'EEXIST') {
        try {
          unlinkSync(lockPath)
        } catch {
          // 锁文件可能不存在
        }
        fail(`无法创建锁文件 ${lockPath}: ${err.message}`)
      }
      if (attempt > 0) fail(`另一个同步进程正在运行（锁文件 ${lockPath}）`)
      if (!lockIsStale(lockPath)) fail(`另一个同步进程正在运行（锁文件 ${lockPath}）`)
      try {
        unlinkSync(lockPath)
      } catch {
        // 下一轮会再次处理
      }
    }
  }

  fail(`无法获取锁文件 ${lockPath}`)
}

function releaseLock(lock) {
  if (!lock) return
  try {
    const data = JSON.parse(readFileSync(lock.path, 'utf8'))
    const own = JSON.parse(lock.payload)
    if (data.pid === own.pid && data.startedAt === own.startedAt) unlinkSync(lock.path)
  } catch {
    // 锁文件已被移除或损坏：无需处理
  }
}

function validateCommitMessage(message) {
  const line = firstLine(message)
  const match = /^([a-z]+)(?:\([^)]+\))?!?:\s+(.+)$/.exec(line)
  if (!match) fail(`提交信息不符合 "type(scope): summary" 格式: ${line}`)

  const type = match[1]
  if (!COMMIT_TYPES.has(type)) {
    fail(`未知提交类型 "${type}"；可用类型: ${[...COMMIT_TYPES].join(', ')}`)
  }

  const summary = match[2]
  const length = [...summary].length
  if (length > 72) fail(`提交摘要超过 72 个字符（${length}）`)
  if (/[.。]\s*$/.test(summary)) fail('提交摘要不要以句号结尾')

  // 只拦 trailer 形状的署名，避免误伤正常提到 openai/anthropic 的提交摘要。
  const attribution =
    /(^|\n)co-authored-by:.*\b(claude|codex|copilot|cursor|anthropic|openai)\b/i.test(message)
  const generated = /(^|\n)generated with\b.*\b(claude|codex|copilot|cursor)\b/i.test(message)
  const signed = /(^|\n)signed-off-by:.*\b(claude|codex)\b/i.test(message)
  if (attribution || generated || signed || message.includes('🤖')) {
    fail('提交信息不得包含 AI/工具署名水印')
  }
}

function assertMainHolderUsable(ctx) {
  if (ctx.branch === TARGET_BRANCH) {
    if (!ctx.mainHolder || !samePath(ctx.mainHolder.path, ctx.top)) {
      fail(`当前分支是 ${TARGET_BRANCH}，但 worktree 列表中的 ${TARGET_BRANCH} 持有者不是当前目录`)
    }
    return
  }

  if (!ctx.mainHolder) return
  if (!existsSync(ctx.mainHolder.path)) {
    fail(`main 工作树路径不存在: ${ctx.mainHolder.path}；可运行 git worktree prune`)
  }

  const status = runGit(['status', '--porcelain'], { cwd: ctx.mainHolder.path })
  if (status.status !== 0) {
    fail(`无法读取 main 工作树状态: ${gitErrorText(status)}`)
  }
  if (status.stdout.trim()) {
    fail(`main 工作树有未提交改动: ${ctx.mainHolder.path}；请先提交或清理后再运行`)
  }

  const pending = pendingOperation(ctx.mainHolder.path)
  if (pending) fail(`main 工作树有进行中的 ${pending} 操作: ${ctx.mainHolder.path}`)
}

function commitCurrentWorktree(ctx, options) {
  const status = git(['status', '--porcelain'], { cwd: ctx.top })
  if (!status.trim()) {
    log('当前 worktree 没有未提交改动')
    return { committed: false }
  }

  const changes = status.split(/\r?\n/).filter(Boolean)
  if (!options.message) {
    fail(
      '当前 worktree 有未提交改动；请按 docs/development/git-commit-msg-rule.md 生成提交信息并通过 --message 传入',
    )
  }
  validateCommitMessage(options.message)
  const oldHead = git(['rev-parse', 'HEAD'], { cwd: ctx.top }).trim()

  if (options.dryRun) {
    log(`[dry-run] 将提交 ${changes.length} 项改动: ${firstLine(options.message)}`)
    return { committed: false, dirty: true, planned: true, oldHead, files: changes }
  }

  git(['add', '-A'], { cwd: ctx.top })
  const staged = git(['diff', '--cached', '--name-only', '-z'], { cwd: ctx.top })
    .split('\0')
    .filter(Boolean)
  if (staged.length === 0) {
    warn('git status 有输出，但没有可暂存的文件（可能只有 submodule 内部改动）；跳过提交')
    return { committed: false, dirty: true }
  }

  const commit = runGit(['commit', '-m', options.message], { cwd: ctx.top, timeout: 900_000 })
  if (commit.status !== 0) fail(`git commit 失败: ${gitErrorText(commit)}`)

  const newHead = git(['rev-parse', 'HEAD'], { cwd: ctx.top }).trim()
  log(`提交 ${short(oldHead)} -> ${short(newHead)}（${staged.length} 个文件）`)
  log(`  ${firstLine(options.message)}`)

  const after = gitMaybe(['status', '--porcelain'], { cwd: ctx.top })
  if (after.status === 0 && after.stdout.trim()) {
    warn('提交后当前 worktree 仍有改动（可能来自 submodule 内部）；同步时可能被跳过')
  }

  return { committed: true, oldHead, newHead, files: staged }
}

function fetchOriginMain(ctx) {
  const res = runGit(['fetch', REMOTE, TARGET_BRANCH], {
    cwd: ctx.top,
    timeout: FETCH_TIMEOUT_MS,
  })
  if (res.status !== 0) fail(`git fetch ${REMOTE} ${TARGET_BRANCH} 失败: ${gitErrorText(res)}`)
  const sha = git(['rev-parse', '--verify', `refs/remotes/${REMOTE}/${TARGET_BRANCH}^{commit}`], {
    cwd: ctx.top,
  }).trim()
  log(`fetch ${REMOTE}/${TARGET_BRANCH} -> ${short(sha)}`)
  return sha
}

function resolveRemoteSha(ctx, dryRun) {
  if (!dryRun) return fetchOriginMain(ctx)

  // dry-run 不 fetch：优先用本地已有的 remote-tracking 对象，ls-remote 只用于提示缓存是否过期。
  const cached = gitMaybe(
    ['rev-parse', '--verify', `refs/remotes/${REMOTE}/${TARGET_BRANCH}^{commit}`],
    { cwd: ctx.top },
  )
  const cachedSha = cached.status === 0 ? cached.stdout.trim() : undefined
  const probe = runGit(['ls-remote', '--heads', REMOTE, TARGET_BRANCH], {
    cwd: ctx.top,
    timeout: 60_000,
  })
  let remoteSha
  if (probe.status === 0) {
    const line = probe.stdout.trim().split(/\r?\n/).find(Boolean)
    if (!line) fail(`远端不存在 ${REMOTE}/${TARGET_BRANCH}`)
    remoteSha = line.split(/\s+/)[0]
  } else {
    warn(`ls-remote 失败，dry-run 使用缓存做预测: ${gitErrorText(probe)}`)
  }

  if (cachedSha) {
    if (remoteSha && remoteSha !== cachedSha) {
      warn(
        `${REMOTE}/${TARGET_BRANCH} 已前进（缓存 ${short(cachedSha)}，远端 ${short(remoteSha)}）；dry-run 不 fetch`,
      )
    }
    return cachedSha
  }
  if (remoteSha) {
    warn(`本地没有缓存的 ${REMOTE}/${TARGET_BRANCH}；dry-run 以远端 SHA 预测，相关对象可能不在本地`)
    return remoteSha
  }
  warn(`无法确定 ${REMOTE}/${TARGET_BRANCH}；dry-run 以本地 ${TARGET_BRANCH} 为基准`)
  return undefined
}

function getLocalMainSha(ctx) {
  const res = gitMaybe(['rev-parse', '--verify', `refs/heads/${TARGET_BRANCH}^{commit}`], {
    cwd: ctx.top,
  })
  return res.status === 0 ? res.stdout.trim() : undefined
}

function ensureLocalMain(ctx, remoteSha) {
  const local = getLocalMainSha(ctx)
  if (local) return local
  if (ctx.mainHolder) {
    fail(`worktree 列表显示 ${TARGET_BRANCH} 被检出，但 refs/heads/${TARGET_BRANCH} 不存在`)
  }
  git(['branch', TARGET_BRANCH, remoteSha], { cwd: ctx.top })
  log(`创建本地 ${TARGET_BRANCH} -> ${short(remoteSha)}`)
  return remoteSha
}

function isAncestor(a, b, cwd) {
  const res = runGit(['merge-base', '--is-ancestor', a, b], { cwd })
  if (res.status === 0) return true
  if (res.status === 1) return false
  fail(`git merge-base --is-ancestor ${a} ${b} 失败: ${gitErrorText(res)}`)
}

function classifyRelation(localSha, remoteSha, cwd) {
  if (localSha === remoteSha) return 'equal'
  if (isAncestor(localSha, remoteSha, cwd)) return 'behind'
  if (isAncestor(remoteSha, localSha, cwd)) return 'ahead'
  return 'diverged'
}

function describeRelation(relation) {
  switch (relation) {
    case 'equal':
      return '一致'
    case 'behind':
      return '将快进'
    case 'ahead':
      return '本地领先，将 push'
    case 'diverged':
      return '分叉，将 rebase 本地提交'
    default:
      return '未知'
  }
}

function getMainWorkspace(ctx) {
  if (ctx.mainHolder) return { path: ctx.mainHolder.path, temporary: false }

  const base = mkdtempSync(join(tmpdir(), 'universe-sync-'))
  const path = join(base, TARGET_BRANCH)
  const res = runGit(['worktree', 'add', '-q', path, TARGET_BRANCH], { cwd: ctx.top })
  if (res.status !== 0) {
    try {
      rmSync(base, { recursive: true, force: true })
    } catch {
      // 临时目录清理失败不影响主流程
    }
    fail(`创建临时 worktree 失败: ${gitErrorText(res)}`)
  }
  log(`创建临时 worktree: ${path}`)
  return { path, temporary: true, base }
}

function closeMainWorkspace(ws, ctx) {
  if (!ws || !ws.temporary) return

  if (pendingOperation(ws.path)) {
    warn(`临时 worktree 仍有进行中操作，保留以便排查: ${ws.path}`)
    return
  }
  const status = runGit(['status', '--porcelain'], { cwd: ws.path })
  if (status.status !== 0 || status.stdout.trim()) {
    warn(`临时 worktree 不干净，保留以便排查: ${ws.path}`)
    return
  }

  const remove = runGit(['worktree', 'remove', '--force', ws.path], { cwd: ctx.top })
  if (remove.status !== 0) {
    warn(`删除临时 worktree 失败: ${gitErrorText(remove)}；路径: ${ws.path}`)
    return
  }
  try {
    rmSync(ws.base, { recursive: true, force: true })
  } catch {
    // 临时目录清理失败不影响主流程
  }
}

function updateSubmodulesIfPresent(path) {
  if (!existsSync(join(path, '.gitmodules'))) return
  const res = runGit(['submodule', 'update', '--init', '--recursive'], {
    cwd: path,
    timeout: SUBMODULE_TIMEOUT_MS,
  })
  if (res.status !== 0) fail(`git submodule update 失败（${path}）: ${gitErrorText(res)}`)
  log(`submodule 已更新（${path}）`)
}

function reconcileMain(ctx, remoteSha) {
  const localSha = ensureLocalMain(ctx, remoteSha)
  const relation = classifyRelation(localSha, remoteSha, ctx.top)
  let workspace
  let mainSha = localSha

  if (relation === 'equal') {
    log(`main 与 ${REMOTE}/${TARGET_BRANCH} 一致（${short(localSha)}）`)
  } else if (relation === 'ahead') {
    log(`main 领先 ${REMOTE}/${TARGET_BRANCH}（${short(localSha)} vs ${short(remoteSha)}）`)
  } else if (relation === 'behind') {
    log(`main 落后 ${REMOTE}/${TARGET_BRANCH}（${short(localSha)} -> ${short(remoteSha)}）`)
    if (ctx.mainHolder) {
      git(['merge', '--ff-only', remoteSha], { cwd: ctx.mainHolder.path })
      updateSubmodulesIfPresent(ctx.mainHolder.path)
    } else {
      git(['branch', '-f', TARGET_BRANCH, remoteSha], { cwd: ctx.top })
    }
    mainSha = remoteSha
    log(`main 快进 -> ${short(mainSha)}`)
  } else {
    log(
      `main 与 ${REMOTE}/${TARGET_BRANCH} 分叉（本地 ${short(localSha)}，远端 ${short(remoteSha)}），将 rebase 本地提交`,
    )
    workspace = getMainWorkspace(ctx)
    const rebase = runGit(['rebase', '--empty=drop', remoteSha], {
      cwd: workspace.path,
      timeout: 300_000,
    })
    if (rebase.status !== 0) {
      const abort = runGit(['rebase', '--abort'], { cwd: workspace.path })
      if (abort.status !== 0) warn(`git rebase --abort 失败: ${gitErrorText(abort)}`)
      fail(
        `本地 ${TARGET_BRANCH} rebase 到 ${REMOTE}/${TARGET_BRANCH} 失败: ${gitErrorText(rebase)}`,
      )
    }
    mainSha = git(['rev-parse', 'HEAD'], { cwd: workspace.path }).trim()
    updateSubmodulesIfPresent(workspace.path)
    log(`main rebase -> ${short(mainSha)}`)
  }

  return { relation, localSha, remoteSha, mainSha, workspace }
}

function listCommitsToPick(ctx, baseRef) {
  if (ctx.branch === TARGET_BRANCH) return []

  const head = git(['rev-parse', 'HEAD'], { cwd: ctx.top }).trim()
  const res = runGit(['rev-list', '--reverse', `${baseRef}..${head}`], { cwd: ctx.top })
  if (res.status !== 0) fail(`无法计算 ${baseRef}..HEAD: ${gitErrorText(res)}`)

  const shas = res.stdout.split(/\r?\n/).filter(Boolean)
  for (const sha of shas) {
    const parents = git(['rev-list', '--parents', '-n', '1', sha], { cwd: ctx.top })
      .trim()
      .split(/\s+/)
    if (parents.length > 2) {
      fail(
        `提交 ${short(sha)} 是 merge commit，无法自动 cherry-pick；请先 squash 或 rebase --no-merges`,
      )
    }
  }
  return shas
}

function cherryPickCommits(ctx, picks, workspace) {
  const picked = []
  const dropped = []
  log(`逐条 cherry-pick ${picks.length} 个提交到 ${TARGET_BRANCH}`)

  for (const sha of picks) {
    const subject = git(['log', '-1', '--format=%s', sha], { cwd: ctx.top }).trim()
    const before = git(['rev-parse', 'HEAD'], { cwd: workspace.path }).trim()
    const res = runGit(['cherry-pick', '--empty=drop', sha], {
      cwd: workspace.path,
      timeout: 300_000,
    })

    if (res.status !== 0) {
      const unmerged = runGit(['diff', '--name-only', '--diff-filter=U'], {
        cwd: workspace.path,
      })
      const abort = runGit(['cherry-pick', '--abort'], { cwd: workspace.path })
      if (abort.status !== 0) warn(`git cherry-pick --abort 失败: ${gitErrorText(abort)}`)
      const detail = unmerged.stdout.trim()
        ? `冲突文件:\n${unmerged.stdout.trim()}`
        : gitErrorText(res)
      fail(`cherry-pick ${short(sha)} (${subject}) 失败: ${detail}`)
    }

    const after = git(['rev-parse', 'HEAD'], { cwd: workspace.path }).trim()
    if (after === before) {
      dropped.push({ sha, subject })
      log(`  ${short(sha)} ${subject} -> 空提交，已丢弃`)
    } else {
      picked.push({ sha, subject, newSha: after })
      log(`  ${short(sha)} ${subject} -> ${short(after)}`)
    }
  }

  return { picked, dropped }
}

// 复刻 extensions/git/src/gitGraphActions.ts 的 messagesCoveredByTarget：
// 只按 subject 比对，且只去掉输出末尾换行产生的空元素，真实空 subject 保留并拒绝。
function messagesCoveredByTarget(target, cwd, extraSubjects = []) {
  const unique = runGit(['log', '--format=%s', `${target}..HEAD`], { cwd })
  if (unique.status !== 0) return { kind: 'failed', error: gitErrorText(unique) }

  const lines = unique.stdout.split('\n').map((line) => line.trim())
  const uniqueSubjects = lines.filter((line, index, all) => line !== '' || index < all.length - 1)
  if (uniqueSubjects.length === 0) return { kind: 'covered' }

  const mergeBase = runGit(['merge-base', target, 'HEAD'], { cwd })
  let targetLog
  if (mergeBase.status === 0) {
    targetLog = runGit(['log', '--format=%s', `${mergeBase.stdout.trim()}..${target}`], { cwd })
  } else if (mergeBase.status === 1) {
    targetLog = runGit(['log', '--format=%s', target], { cwd })
  } else {
    return { kind: 'failed', error: gitErrorText(mergeBase) }
  }
  if (targetLog.status !== 0) return { kind: 'failed', error: gitErrorText(targetLog) }

  const targetSubjects = new Set(
    targetLog.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  )
  for (const subject of extraSubjects) {
    if (subject) targetSubjects.add(subject)
  }

  const uncovered = uniqueSubjects.filter(
    (subject) => subject === '' || !targetSubjects.has(subject),
  )
  return uncovered.length > 0 ? { kind: 'uncovered', subjects: uncovered } : { kind: 'covered' }
}

function syncOneWorktree(wt, mainSha) {
  const name = basename(wt.path)
  if (!existsSync(wt.path)) {
    return { kind: 'failed', name, error: `路径不存在: ${wt.path}（可运行 git worktree prune）` }
  }

  const headRes = gitMaybe(['rev-parse', 'HEAD'], { cwd: wt.path })
  const oldHead = headRes.status === 0 ? headRes.stdout.trim() : undefined

  const status = runGit(['status', '--porcelain'], { cwd: wt.path })
  if (status.status !== 0) {
    return { kind: 'failed', name, oldHead, error: `git status 失败: ${gitErrorText(status)}` }
  }
  if (status.stdout.trim()) return { kind: 'skippedDirty', name, oldHead }

  const pending = pendingOperation(wt.path)
  if (pending) return { kind: 'skippedInProgress', name, oldHead, marker: pending }

  const coverage = messagesCoveredByTarget(TARGET_BRANCH, wt.path)
  if (coverage.kind === 'failed') return { kind: 'failed', name, oldHead, error: coverage.error }
  if (coverage.kind === 'uncovered') {
    return { kind: 'skippedUnmatched', name, oldHead, subjects: coverage.subjects }
  }

  const reset = runGit(['reset', '--hard', TARGET_BRANCH], { cwd: wt.path })
  if (reset.status !== 0) {
    return { kind: 'failed', name, oldHead, error: `git reset --hard 失败: ${gitErrorText(reset)}` }
  }

  if (existsSync(join(wt.path, '.gitmodules'))) {
    const sub = runGit(['submodule', 'update', '--init', '--recursive'], {
      cwd: wt.path,
      timeout: SUBMODULE_TIMEOUT_MS,
    })
    if (sub.status !== 0) {
      return {
        kind: 'failed',
        name,
        oldHead,
        error: `reset 成功但 submodule 更新失败: ${gitErrorText(sub)}`,
      }
    }
  }

  return { kind: 'synced', name, oldHead, newHead: mainSha }
}

function syncAllWorktrees(ctx, mainWorkspace, mainSha) {
  const worktrees = listWorktrees(ctx.top)
  const excluded = []
  if (ctx.mainHolder) excluded.push(ctx.mainHolder.path)
  if (mainWorkspace) excluded.push(mainWorkspace.path)

  const candidates = worktrees.filter(
    (wt) => !wt.bare && !excluded.some((path) => samePath(path, wt.path)),
  )
  const results = {
    synced: [],
    skippedDirty: [],
    skippedInProgress: [],
    skippedUnmatched: [],
    failed: [],
  }

  log(`同步 ${candidates.length} 个 worktree 到 ${TARGET_BRANCH}（${short(mainSha)}）`)
  for (const wt of candidates) {
    const result = syncOneWorktree(wt, mainSha)
    switch (result.kind) {
      case 'synced':
        results.synced.push(result)
        log(`  ${result.name}: ${short(result.oldHead)} -> ${short(result.newHead)}`)
        break
      case 'skippedDirty':
        results.skippedDirty.push(result)
        log(`  ${result.name}: 跳过（未提交改动）`)
        break
      case 'skippedInProgress':
        results.skippedInProgress.push(result)
        log(`  ${result.name}: 跳过（进行中的 ${result.marker} 操作）`)
        break
      case 'skippedUnmatched':
        results.skippedUnmatched.push(result)
        log(
          `  ${result.name}: 跳过（commit subject 未进 ${TARGET_BRANCH}: ${result.subjects.join('; ')}）`,
        )
        break
      case 'failed':
        results.failed.push(result)
        log(`  ${result.name}: 失败（${result.error}）`)
        break
    }
  }
  return results
}

function buildDryRunPlan(ctx, options, commit, remoteSha, localSha, relation) {
  log('')
  log('DRY RUN — 不会修改任何内容')
  log(`仓库: ${ctx.top}`)
  log(`当前分支: ${ctx.branch}`)

  if (commit.dirty) {
    log(`未提交改动: ${commit.files.length} 项`)
    log(
      `提交信息: ${
        options.message ? firstLine(options.message) : '（缺少 --message，正式执行会中止）'
      }`,
    )
  } else {
    log('未提交改动: 无')
  }

  if (localSha && remoteSha) {
    log(
      `main: 本地 ${short(localSha)}；${REMOTE}/${TARGET_BRANCH} ${short(remoteSha)} -> ${describeRelation(relation)}`,
    )
  } else {
    log('main: 无法确定与远端的差异（dry-run 不 fetch）')
  }

  let baseRef = relation === 'behind' ? `refs/remotes/${REMOTE}/${TARGET_BRANCH}` : TARGET_BRANCH
  const baseExists = gitMaybe(['rev-parse', '--verify', `${baseRef}^{commit}`], { cwd: ctx.top })
  if (baseExists.status !== 0) {
    warn(`无法解析预测基准 ${baseRef}，改用本地 ${TARGET_BRANCH}`)
    baseRef = TARGET_BRANCH
  }

  let picks = []
  try {
    picks = listCommitsToPick(ctx, baseRef)
  } catch (err) {
    if (err instanceof SyncError) warn(`无法预测 cherry-pick: ${err.message}`)
    else throw err
  }

  const plannedPick = commit.planned && ctx.branch !== TARGET_BRANCH
  log(`cherry-pick: ${picks.length} 个已有提交${plannedPick ? ' + 1 个待创建提交' : ''}`)
  for (const sha of picks) {
    const subject = git(['log', '-1', '--format=%s', sha], { cwd: ctx.top }).trim()
    log(`  ${short(sha)} ${subject}`)
  }

  if (options.noPush) log('push: 跳过（--no-push）')
  else log(`push: ${REMOTE} ${TARGET_BRANCH}`)

  const extraSubjects = picks.map((sha) =>
    git(['log', '-1', '--format=%s', sha], { cwd: ctx.top }).trim(),
  )
  if (plannedPick && options.message) extraSubjects.push(firstLine(options.message))

  const excluded = []
  if (ctx.mainHolder) excluded.push(ctx.mainHolder.path)
  const worktrees = listWorktrees(ctx.top).filter(
    (wt) => !wt.bare && !excluded.some((path) => samePath(path, wt.path)),
  )

  log(`worktree 预测（${worktrees.length} 个）:`)
  for (const wt of worktrees) {
    const name = basename(wt.path)
    if (!existsSync(wt.path)) {
      log(`  ${name}: 预计失败（路径不存在）`)
      continue
    }

    const status = runGit(['status', '--porcelain'], { cwd: wt.path })
    if (status.status !== 0) {
      log(`  ${name}: 预计失败（git status 失败）`)
      continue
    }
    const willCommitHere = commit.planned && samePath(wt.path, ctx.top)
    if (status.stdout.trim() && !willCommitHere) {
      log(`  ${name}: 跳过（未提交改动）`)
      continue
    }

    const pending = pendingOperation(wt.path)
    if (pending) {
      log(`  ${name}: 跳过（进行中的 ${pending} 操作）`)
      continue
    }

    const coverage = messagesCoveredByTarget(baseRef, wt.path, extraSubjects)
    if (coverage.kind === 'failed') {
      log(`  ${name}: 预计失败（${coverage.error}）`)
    } else if (coverage.kind === 'uncovered') {
      log(`  ${name}: 预计跳过（subject 未进 ${TARGET_BRANCH}: ${coverage.subjects.join('; ')}）`)
    } else {
      log(`  ${name}: 将同步`)
    }
  }
}

function printSummary({ commit, reconcile, picks, pickResult, pushed, mainSha, sync }) {
  log('')
  log('汇总:')
  if (commit.committed) {
    log(
      `  提交: ${short(commit.oldHead)} -> ${short(commit.newHead)}（${commit.files.length} 个文件）`,
    )
  } else if (commit.dirty) {
    log('  提交: 跳过（没有可暂存的文件）')
  } else {
    log('  提交: 无未提交改动')
  }
  log(`  main: ${describeRelation(reconcile.relation)} -> ${short(mainSha)}`)
  if (picks.length > 0) {
    log(
      `  cherry-pick: ${pickResult.picked.length} 个成功，${pickResult.dropped.length} 个空提交丢弃`,
    )
  } else {
    log('  cherry-pick: 无')
  }
  log(`  push: ${pushed ? `${REMOTE}/${TARGET_BRANCH} 已推送` : '跳过（--no-push）'}`)
  log(`  同步: ${sync.synced.length} 个 worktree`)
  if (sync.synced.length > 0) {
    log(
      `    synced: ${sync.synced
        .map((result) => `${result.name} (${short(result.oldHead)} -> ${short(result.newHead)})`)
        .join(', ')}`,
    )
  }
  if (sync.skippedDirty.length > 0) {
    log(
      `    skipped (uncommitted changes): ${sync.skippedDirty
        .map((result) => result.name)
        .join(', ')}`,
    )
  }
  if (sync.skippedInProgress.length > 0) {
    log(
      `    skipped (operation in progress): ${sync.skippedInProgress
        .map((result) => `${result.name} (${result.marker})`)
        .join(', ')}`,
    )
  }
  if (sync.skippedUnmatched.length > 0) {
    log(`    skipped (no matching commit message in ${TARGET_BRANCH}):`)
    for (const result of sync.skippedUnmatched) {
      log(`      ${result.name}: ${result.subjects.join('; ')}`)
    }
  }
  if (sync.failed.length > 0) {
    log('    failed:')
    for (const result of sync.failed) log(`      ${result.name}: ${result.error}`)
  }
  if (sync.synced.length > 0) {
    log('  提示: 同步会 reset --hard 干净 worktree；如需恢复旧 HEAD，使用 git reflog')
  }
}

function parseArgs(argv) {
  const options = { message: undefined, dryRun: false, noPush: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--no-push') options.noPush = true
    else if (arg === '-h' || arg === '--help') options.help = true
    else if (arg === '-m' || arg === '--message') {
      const value = argv[++i]
      if (value === undefined) fail(`${arg} 缺少值`)
      options.message = value
    } else if (arg.startsWith('--message=')) {
      options.message = arg.slice('--message='.length)
    } else if (arg === '--') {
      continue
    } else {
      fail(`未知参数: ${arg}`)
    }
  }

  if (options.message !== undefined) {
    options.message = options.message.trim()
    if (!options.message) fail('--message 不能为空')
    validateCommitMessage(options.message)
  }
  return options
}

function printHelp() {
  console.log(`用法: node .claude/skills/commit-push-sync-worktrees/commit-push-sync-worktrees.mjs [选项]

选项:
  -m, --message <msg>  当前 worktree 有未提交改动时使用的提交信息
  --dry-run            只读预览，不修改任何内容
  --no-push            跳过 git push
  -h, --help           显示帮助

行为:
  1. 提交当前 worktree 的未提交改动（有改动时 -m 必填）
  2. fetch origin main；落后则快进，分叉则 rebase 本地 main
  3. 当前分支不是 main 时，把 main..HEAD 的提交逐条 cherry-pick 到 main
  4. push origin main（绝不 force）
  5. 把其它 worktree 同步到 main（脏/进行中/独有提交未覆盖则跳过）

退出码: 0 成功（worktree 跳过不算失败）；1 硬失败`)
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`[sync] 失败: ${err.message}`)
    process.exitCode = 1
    return
  }

  if (options.help) {
    printHelp()
    return
  }

  let ctx
  let lock
  let workspace
  try {
    ctx = resolveContext()

    if (options.dryRun) {
      const lockPath = join(ctx.commonDir, 'commit-push-sync.lock')
      if (existsSync(lockPath)) {
        warn(`检测到锁文件 ${lockPath}，可能有另一个同步进程正在运行；dry-run 计划可能已过期`)
      }
    } else {
      lock = acquireLock(ctx.commonDir)
    }

    assertMainHolderUsable(ctx)
    const commit = commitCurrentWorktree(ctx, options)

    const remoteSha = resolveRemoteSha(ctx, options.dryRun)
    const localSha = getLocalMainSha(ctx)
    const relation =
      remoteSha && localSha ? classifyRelation(localSha, remoteSha, ctx.top) : undefined

    if (options.dryRun) {
      buildDryRunPlan(ctx, options, commit, remoteSha, localSha, relation)
      return
    }

    const reconcile = reconcileMain(ctx, remoteSha)
    workspace = reconcile.workspace

    const picks = listCommitsToPick(ctx, TARGET_BRANCH)
    let pickResult = { picked: [], dropped: [] }
    if (picks.length > 0) {
      if (!workspace) workspace = getMainWorkspace(ctx)
      pickResult = cherryPickCommits(ctx, picks, workspace)
      updateSubmodulesIfPresent(workspace.path)
    }

    const mainSha = git(['rev-parse', `refs/heads/${TARGET_BRANCH}`], { cwd: ctx.top }).trim()

    if (options.noPush) {
      log('PUSH SKIPPED (--no-push)')
    } else {
      const push = runGit(['push', REMOTE, TARGET_BRANCH], {
        cwd: ctx.top,
        timeout: PUSH_TIMEOUT_MS,
      })
      if (push.status !== 0) {
        fail(`git push ${REMOTE} ${TARGET_BRANCH} 失败: ${gitErrorText(push)}`)
      }
      log(`push ${REMOTE} ${TARGET_BRANCH} -> ${short(mainSha)}`)
    }

    const sync = syncAllWorktrees(ctx, workspace, mainSha)
    printSummary({
      commit,
      reconcile,
      picks,
      pickResult,
      pushed: !options.noPush,
      mainSha,
      sync,
    })

    if (sync.failed.length > 0) process.exitCode = 1
  } catch (err) {
    if (err instanceof SyncError) {
      console.error(`[sync] 失败: ${err.message}`)
    } else {
      console.error(`[sync] 未预期错误: ${err.stack ?? err}`)
    }
    process.exitCode = 1
  } finally {
    try {
      closeMainWorkspace(workspace, ctx)
    } catch (err) {
      warn(`清理临时 worktree 时出错: ${err.message}`)
    }
    releaseLock(lock)
  }
}

main()
