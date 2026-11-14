#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  push 前范围闸门。检查 origin/main..HEAD 的待推送提交是否还在「自动处理」的
 *  安全范围内：无 merge / 文件数与行数上限 / 无二进制改动 / 禁改路径 / 每日配额。
 *
 *    node scripts/tracker/gate.mjs
 *    node scripts/tracker/gate.mjs --base origin/main --max-files 5 --max-lines 200
 *    node scripts/tracker/gate.mjs --install-hook
 *    node scripts/tracker/gate.mjs --install-hook --refs-prefix ci#   # CI 修复 bot clone
 *
 *  每日配额按 `Refs: <prefix>` 分别计数：tracker# 上限 5，ci# 上限 3；阈值只能调低。
 *  hook 安装时把前缀写进 hook，push 时无需再传参数。
 *  纯判定逻辑以导出函数形式提供，便于 node:test 单测。
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HARD_MAX_FILES = 8
export const HARD_MAX_LINES = 300
export const DEFAULT_BASE = 'origin/main'
export const DEFAULT_REFS_PREFIX = 'tracker#'
export const DAILY_COMMIT_LIMITS = Object.freeze({ 'tracker#': 5, 'ci#': 3 })
const HOOK_MARKER = 'UE_TRACKER_GATE'

export const FORBIDDEN_PATTERNS = [
  '**/pnpm-lock.yaml',
  '**/package.json',
  '**/pnpm-workspace.yaml',
  '.github/**',
  '**/electron-builder.yml',
  'scripts/release/**',
  'scripts/server/**',
  'scripts/tracker/**',
  'vendor/**',
  'packages/config-*/**',
  '**/.env*',
  'scripts/sensitive-*',
  '**/CLAUDE.md',
  '**/.universe-editor/triggers.json',
]

function escapeRegExpChar(ch) {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch
}

export function globToRegExp(pattern) {
  const normalized = pattern.replace(/\\/g, '/')
  let source = ''
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        i++
        if (normalized[i + 1] === '/') {
          i++
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
    } else if (ch === '?') {
      source += '[^/]'
    } else {
      source += escapeRegExpChar(ch)
    }
  }
  return new RegExp(`^${source}$`)
}

const FORBIDDEN_MATCHERS = FORBIDDEN_PATTERNS.map((pattern) => ({
  pattern,
  matcher: globToRegExp(pattern),
}))

export function isForbiddenPath(file) {
  const normalized = String(file).replace(/\\/g, '/').replace(/^\.\//, '')
  return FORBIDDEN_MATCHERS.some(({ matcher }) => matcher.test(normalized))
}

export function parseNumstat(text) {
  const files = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const additions = parts[0]
    const deletions = parts[1]
    const path = parts.slice(2).join('\t')
    const binary = additions === '-' || deletions === '-'
    files.push({
      path,
      additions: binary ? null : Number(additions),
      deletions: binary ? null : Number(deletions),
      binary,
    })
  }
  return files
}

export function resolveThresholds({ maxFiles, maxLines } = {}) {
  const values = { maxFiles, maxLines }
  const limits = { maxFiles: HARD_MAX_FILES, maxLines: HARD_MAX_LINES }
  const result = {}
  for (const key of ['maxFiles', 'maxLines']) {
    const value = values[key]
    if (value === undefined) {
      result[key] = limits[key]
      continue
    }
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`--${key.replace('max', 'max-').toLowerCase()} 必须是正整数`)
    }
    if (value > limits[key]) {
      throw new Error(`--${key.replace('max', 'max-').toLowerCase()} 不能超过硬上限 ${limits[key]}`)
    }
    result[key] = value
  }
  return result
}

export function resolveRefsPrefix(value = DEFAULT_REFS_PREFIX) {
  if (!Object.hasOwn(DAILY_COMMIT_LIMITS, value)) {
    throw new Error(
      `--refs-prefix 只支持 ${Object.keys(DAILY_COMMIT_LIMITS).join(' / ')}，收到 ${value}`,
    )
  }
  return value
}

export function resolveDailyLimit(refsPrefix = DEFAULT_REFS_PREFIX, value) {
  const hardLimit = DAILY_COMMIT_LIMITS[resolveRefsPrefix(refsPrefix)]
  if (value === undefined) return hardLimit
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('--daily-limit 必须是正整数')
  }
  if (value > hardLimit) {
    throw new Error(`--daily-limit 不能超过 ${refsPrefix} 的硬上限 ${hardLimit}`)
  }
  return value
}

/**
 * @param {{
 *   mergeCommits: string[],
 *   files: ReturnType<typeof parseNumstat>,
 *   pendingCommits: number,
 *   dailyRefCommits: number,
 *   refsPrefix?: string,
 *   dailyLimit?: number,
 *   thresholds: {maxFiles: number, maxLines: number},
 * }} input
 */
export function evaluateGate({
  mergeCommits,
  files,
  pendingCommits,
  dailyRefCommits = 0,
  refsPrefix = DEFAULT_REFS_PREFIX,
  dailyLimit = DAILY_COMMIT_LIMITS[refsPrefix],
  thresholds,
}) {
  const prefix = resolveRefsPrefix(refsPrefix)
  const limit = resolveDailyLimit(prefix, dailyLimit)
  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0)
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
  const lines = additions + deletions
  const binaryFiles = [...new Set(files.filter((file) => file.binary).map((file) => file.path))]
  const forbiddenFiles = [
    ...new Set(files.filter((file) => isForbiddenPath(file.path)).map((file) => file.path)),
  ]

  const violations = []
  if (mergeCommits.length > 0) {
    violations.push(`待推送提交包含 merge commit: ${mergeCommits.join(', ')}`)
  }
  if (files.length > thresholds.maxFiles) {
    violations.push(`改动文件数 ${files.length} 超过上限 ${thresholds.maxFiles}`)
  }
  if (lines > thresholds.maxLines) {
    violations.push(`增删行合计 ${lines} 超过上限 ${thresholds.maxLines}`)
  }
  if (binaryFiles.length > 0) {
    violations.push(`包含二进制改动: ${binaryFiles.join(', ')}`)
  }
  if (forbiddenFiles.length > 0) {
    violations.push(`修改了禁改路径: ${forbiddenFiles.join(', ')}`)
  }
  if (dailyRefCommits + pendingCommits > limit) {
    violations.push(
      `最近 24h 已推 ${dailyRefCommits} 个 Refs: ${prefix} 提交，本次 ${pendingCommits} 个，超过每日上限 ${limit}`,
    )
  }

  return {
    ok: violations.length === 0,
    violations,
    stats: {
      commits: pendingCommits,
      files: files.length,
      additions,
      deletions,
      lines,
      binaryFiles: binaryFiles.length,
      forbiddenFiles: forbiddenFiles.length,
      dailyRefCommits,
      refsPrefix: prefix,
      dailyLimit: limit,
    },
  }
}

function git(repoRoot, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) throw new Error(`无法执行 git: ${result.error.message}`)
  if (!allowFailure && result.status !== 0) {
    const detail = (result.stderr || '').trim()
    throw new Error(`git ${args.join(' ')} 失败${detail === '' ? '' : `: ${detail}`}`)
  }
  return result
}

function lines(text) {
  return String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

function repoRootOf(repoRoot) {
  const result = git(repoRoot, ['rev-parse', '--show-toplevel'], { allowFailure: true })
  return result.status === 0 ? result.stdout.trim() : repoRoot
}

export function runGate({
  repoRoot = process.cwd(),
  base = DEFAULT_BASE,
  maxFiles,
  maxLines,
  refsPrefix = DEFAULT_REFS_PREFIX,
  dailyLimit,
} = {}) {
  const thresholds = resolveThresholds({ maxFiles, maxLines })
  const prefix = resolveRefsPrefix(refsPrefix)
  const limit = resolveDailyLimit(prefix, dailyLimit)
  const root = repoRootOf(repoRoot)

  const baseCheck = git(root, ['rev-parse', '--verify', '--quiet', base], { allowFailure: true })
  if (baseCheck.status !== 0) {
    throw new Error(`找不到基准 ${base}；先 git fetch origin main，或用 --base 指定`)
  }

  const pendingCommits = lines(git(root, ['rev-list', `${base}..HEAD`]).stdout)

  const originMain = git(root, ['rev-parse', '--verify', '--quiet', 'origin/main'], {
    allowFailure: true,
  })
  const dailyRef = originMain.status === 0 ? 'origin/main' : base
  const dailyRefCommits = lines(
    git(root, [
      'log',
      dailyRef,
      '--since=24.hours',
      '--fixed-strings',
      `--grep=Refs: ${prefix}`,
      '--format=%H',
    ]).stdout,
  ).length

  if (pendingCommits.length === 0) {
    // HEAD 落后 origin/main 时，base..HEAD 的 diff 是反向差异，不能当成待推送改动。
    return {
      ok: true,
      violations: [],
      stats: {
        commits: 0,
        files: 0,
        additions: 0,
        deletions: 0,
        lines: 0,
        binaryFiles: 0,
        forbiddenFiles: 0,
        dailyRefCommits,
        refsPrefix: prefix,
        dailyLimit: limit,
      },
      base,
      dailyRef,
      thresholds,
      pendingCommits: 0,
    }
  }

  const mergeCommits = lines(git(root, ['rev-list', '--merges', `${base}..HEAD`]).stdout)
  const files = parseNumstat(
    git(root, ['diff', '--numstat', '--no-renames', `${base}...HEAD`]).stdout,
  )

  const result = evaluateGate({
    mergeCommits,
    files,
    pendingCommits: pendingCommits.length,
    dailyRefCommits,
    refsPrefix: prefix,
    dailyLimit: limit,
    thresholds,
  })
  return { ...result, base, dailyRef, thresholds, pendingCommits: pendingCommits.length }
}

export function formatGateResult(result) {
  const { stats } = result
  const lines = [
    `[tracker-gate] base=${result.base} commits=${stats.commits} files=${stats.files} lines=+${stats.additions}/-${stats.deletions} refsPrefix=${stats.refsPrefix} dailyRefCommits=${stats.dailyRefCommits}`,
  ]
  if (result.ok) {
    lines.push(
      stats.commits === 0
        ? '[tracker-gate] 结果: 通过（没有待推送提交）'
        : '[tracker-gate] 结果: 通过',
    )
  } else {
    lines.push('[tracker-gate] 违规:')
    for (const violation of result.violations) lines.push(`  - ${violation}`)
    lines.push('[tracker-gate] 结果: 未通过')
  }
  return lines.join('\n')
}

const HOOK_CONTENT_PREFIX = `#!/bin/sh
# ${HOOK_MARKER}: generated by scripts/tracker/gate.mjs --install-hook
exec node "$(git rev-parse --show-toplevel)/scripts/tracker/gate.mjs" --refs-prefix '`

export function installHook({ repoRoot = process.cwd(), refsPrefix = DEFAULT_REFS_PREFIX } = {}) {
  const prefix = resolveRefsPrefix(refsPrefix)
  const root = repoRootOf(repoRoot)
  const hooksPath = git(root, ['rev-parse', '--git-path', 'hooks']).stdout.trim()
  const hooksDir = isAbsolute(hooksPath) ? hooksPath : resolve(root, hooksPath)
  mkdirSync(hooksDir, { recursive: true })

  const hookPath = join(hooksDir, 'pre-push')
  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, 'utf8')
    if (!existing.includes(HOOK_MARKER)) {
      throw new Error(
        `已存在非本脚本生成的 pre-push hook: ${hookPath}；请手动合并或先移走，拒绝覆盖`,
      )
    }
  }

  writeFileSync(hookPath, `${HOOK_CONTENT_PREFIX}${prefix}'\n`, 'utf8')
  chmodSync(hookPath, 0o755)
  return hookPath
}

export function parseArgs(argv) {
  const options = { base: DEFAULT_BASE }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--base') {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) throw new Error('--base 需要基准 ref')
      options.base = value
    } else if (arg === '--max-files' || arg === '--max-lines' || arg === '--daily-limit') {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${arg} 需要数字`)
      const number = Number(value)
      if (!Number.isInteger(number)) throw new Error(`${arg} 需要整数`)
      const key =
        arg === '--max-files' ? 'maxFiles' : arg === '--max-lines' ? 'maxLines' : 'dailyLimit'
      options[key] = number
    } else if (arg === '--refs-prefix') {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--refs-prefix 需要前缀（tracker# 或 ci#）')
      }
      options.refsPrefix = value
    } else if (arg === '--install-hook') {
      options.installHook = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`未知参数: ${arg}`)
    }
  }
  return options
}

function usage() {
  process.stdout.write(
    [
      '用法: node scripts/tracker/gate.mjs [选项]',
      '  --base <ref>          基准（默认 origin/main）',
      '  --max-files <n>       文件数上限（默认 8，不能调高）',
      '  --max-lines <n>       增删行上限（默认 300，不能调高）',
      '  --refs-prefix <前缀>  每日配额统计的提交前缀：tracker#（默认，上限 5）或 ci#（上限 3）',
      '  --daily-limit <n>     每日提交上限（只能调低）',
      '  --install-hook        写入 .git/hooks/pre-push（把 --refs-prefix 写进 hook）',
      '',
    ].join('\n'),
  )
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`[tracker-gate] ${error.message}\n`)
    process.exitCode = 1
    return
  }

  if (options.help) {
    usage()
    return
  }

  try {
    if (options.installHook) {
      const refsPrefix = resolveRefsPrefix(options.refsPrefix)
      const hookPath = installHook({ refsPrefix })
      process.stdout.write(
        `[tracker-gate] 已写入 pre-push hook: ${hookPath}（refsPrefix=${refsPrefix}）\n`,
      )
      return
    }
    const result = runGate(options)
    process.stdout.write(`${formatGateResult(result)}\n`)
    if (!result.ok) process.exitCode = 1
  } catch (error) {
    process.stderr.write(`[tracker-gate] ${error.message}\n`)
    process.exitCode = 1
  }
}

const invokedDirectly = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (invokedDirectly) main()
