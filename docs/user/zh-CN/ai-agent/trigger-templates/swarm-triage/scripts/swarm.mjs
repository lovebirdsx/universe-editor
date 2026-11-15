#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Swarm 审核操作的 CLI（零依赖，node 内置 + 全局 fetch）。
 *
 *    node .claude/skills/swarm-triage/scripts/swarm.mjs get 100801 --url https://swarm.example.com
 *    node .claude/skills/swarm-triage/scripts/swarm.mjs vote 100801 up
 *    node .claude/skills/swarm-triage/scripts/swarm.mjs comment 100801 --body "已核对"
 *    node .claude/skills/swarm-triage/scripts/swarm.mjs comment 100801 --body-file note.md
 *    node .claude/skills/swarm-triage/scripts/swarm.mjs approve 100801
 *
 *  凭据复用本机 p4 登录 ticket（`p4 login -s` 判活 + `p4 tickets` 取 ticket），
 *  以 HTTP Basic 发送。RED LINE：ticket / Authorization 绝不出现在 stdout、stderr
 *  或任何错误信息里；HTTP 错误只报 method + path + status，网络错误只报 method + path。
 *
 *  本脚本不校验 --url 指向哪台主机：高权限模式下 Agent 本来就能执行任意命令，
 *  加校验给不了真实保护；保守模式下每条写命令都会弹出带完整命令行的审批卡。
 *  skill 侧必须把 --url 钉死为事件数据里的 swarmUrl（见 SKILL.md）。
 *
 *  approve 只把审核状态改为 approved，永不提交（没有 commit 选项）。
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_API_VERSION = 'v9'
const DESCRIPTION_LIMIT = 2000
/** 与 extensions/perforce 的 CREDENTIAL_PROBE_TIMEOUT_MS 一致。 */
const P4_TIMEOUT_MS = 15_000
/** 与 extensions/perforce 的 DEFAULT_REQUEST_TIMEOUT_MS（swarmApi.ts）一致。 */
const REQUEST_TIMEOUT_MS = 30_000

/** 参数 / 用法错误 → 退出码 2（运行期错误是 1）。 */
export class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}

/** HTTP 失败。只带 method / path / status，绝不带 URL 或请求头。 */
export class SwarmHttpError extends Error {
  constructor(method, path, status) {
    super(`${method} ${path} 失败：HTTP ${status}`)
    this.name = 'SwarmHttpError'
    this.method = method
    this.path = path
    this.status = status
  }
}

function readOptionValue(argv, index, name) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new UsageError(`${name} 需要值`)
  }
  return value
}

/**
 * 解析 argv。位置参数：`<command> <reviewId> [up|down]`。
 * 选项：`--url` / `--api` / `--user` / `--body` / `--body-file` / `--help`。
 */
export function parseArgs(argv) {
  const options = { apiVersion: DEFAULT_API_VERSION }
  const positionals = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--url') {
      options.url = readOptionValue(argv, i, '--url')
      i++
    } else if (arg === '--api') {
      options.apiVersion = readOptionValue(argv, i, '--api')
      i++
    } else if (arg === '--user') {
      options.user = readOptionValue(argv, i, '--user')
      i++
    } else if (arg === '--body-file') {
      options.bodyFile = readOptionValue(argv, i, '--body-file')
      i++
    } else if (arg === '--body') {
      const value = argv[i + 1]
      if (value === undefined) throw new UsageError('--body 需要正文')
      options.body = value
      i++
    } else if (arg.startsWith('-')) {
      throw new UsageError(`未知参数: ${arg}`)
    } else {
      positionals.push(arg)
    }
  }

  if (options.help) return options

  const [command, reviewId, vote] = positionals
  if (command === undefined) throw new UsageError('缺少子命令（get / vote / comment / approve）')
  if (!['get', 'vote', 'comment', 'approve'].includes(command)) {
    throw new UsageError(`未知子命令: ${command}`)
  }
  if (reviewId === undefined || reviewId.trim() === '') {
    throw new UsageError(`${command} 需要 <reviewId>`)
  }
  options.command = command
  options.reviewId = reviewId.trim()
  if (positionals.length > 3) throw new UsageError('多余的参数')

  if (command === 'vote') {
    if (vote !== 'up' && vote !== 'down') {
      throw new UsageError('vote 需要方向 up 或 down')
    }
    options.vote = vote
  } else if (vote !== undefined) {
    throw new UsageError(`${command} 不接受额外参数: ${vote}`)
  }

  if (command === 'comment') {
    if (options.body !== undefined && options.bodyFile !== undefined) {
      throw new UsageError('--body 与 --body-file 只能给一个')
    }
    if (options.body === undefined && options.bodyFile === undefined) {
      throw new UsageError('comment 需要 --body <text> 或 --body-file <path>')
    }
  } else if (options.body !== undefined || options.bodyFile !== undefined) {
    throw new UsageError(`${command} 不接受 --body / --body-file`)
  }

  return options
}

export function usageText() {
  return [
    '用法: node swarm.mjs <command> <reviewId> [选项]',
    '',
    '命令:',
    '  get <reviewId>                 读取审核摘要（id / state / author / description / 版本 / 可转换状态）',
    '  vote <reviewId> up|down        投票（自动带上最新版本号）',
    '  comment <reviewId> --body <text>',
    '  comment <reviewId> --body-file <path>',
    '  approve <reviewId>             把状态改为 approved（永不提交）',
    '',
    '选项:',
    '  --url <swarmBase>   Swarm 地址，例如 https://swarm.example.com（缺省读 UE_SWARM_URL）',
    '  --api <version>     Swarm API 版本（默认 v9）',
    '  --user <name>       Perforce 用户名（缺省读 P4USER / p4 -ztag info 的 userName）',
    '  --help, -h          显示本帮助',
    '',
  ].join('\n')
}

/** 从 `p4 -ztag info` 输出里取 userName。 */
export function parseUserName(output) {
  const match = /^\.\.\. userName[ \t]+(.+)$/m.exec(String(output ?? ''))
  return match?.[1]?.trim() || undefined
}

/** 从 `p4 tickets` 输出里挑出属于 user 的 ticket。p4 用户名大小写不敏感，后出现的优先。 */
export function pickTicketForUser(stdout, user) {
  let found
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const match = /^\S+\s+\(([^)]+)\)\s+(\S+)\s*$/.exec(line.trim())
    if (match === null) continue
    const [, lineUser, ticket] = match
    if (lineUser && ticket && lineUser.toLowerCase() === String(user).toLowerCase()) {
      found = ticket
    }
  }
  return found
}

/** `Basic <base64(user:secret)>`。 */
export function buildBasicAuth(user, secret) {
  return 'Basic ' + Buffer.from(`${user}:${secret}`, 'utf8').toString('base64')
}

export function defaultRunP4(args, { cwd = process.cwd() } = {}) {
  return spawnSync('p4', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: P4_TIMEOUT_MS,
  })
}

/**
 * spawnSync 的超时 / 被杀会体现在 `result.error` / `result.signal` 上（`status` 为 null）。
 * 只返回可归因的原因，绝不回显 stdout / stderr——ticket 可能出现在其中。
 */
export function p4FailureReason(result) {
  const error = result?.error
  if (error) {
    return error.code === 'ETIMEDOUT' || error.name === 'TimeoutError'
      ? `p4 执行超时（${P4_TIMEOUT_MS / 1000} 秒）`
      : `p4 无法执行（${error.code ?? error.name ?? 'unknown'}）`
  }
  if (result?.signal) return `p4 被信号 ${result.signal} 终止`
  return undefined
}

/**
 * 解析 Basic 凭据：先定 user（--user > P4USER > `p4 -ztag info`），
 * 再用 `p4 login -s` 确认会话仍然有效，最后从 `p4 tickets` 读已签发的 ticket。
 * 任何 p4 的 stdout / stderr 都不进错误信息（ticket 可能出现在其中）。
 */
export function resolveAuth({ runP4, cwd, env, userOverride }) {
  let user = userOverride ?? env.P4USER
  if (!user) {
    const info = runP4(['-ztag', 'info'], { cwd })
    const failure = p4FailureReason(info)
    if (failure) throw new Error(`${failure}，无法确定 Perforce 用户名`)
    if (info?.status !== 0) throw new Error('p4 -ztag info 失败，无法确定 Perforce 用户名')
    user = parseUserName(info.stdout)
  }
  if (!user) throw new Error('无法确定 Perforce 用户名：请用 --user 或设置 P4USER')

  const login = runP4(['login', '-s'], { cwd })
  const loginFailure = p4FailureReason(login)
  if (loginFailure) {
    throw new Error(`${loginFailure}，无法确认 Perforce 登录状态（用户 ${user}）`)
  }
  if (login?.status !== 0) {
    throw new Error(`Perforce 会话未登录或已过期（用户 ${user}），请先在终端执行 p4 login`)
  }

  const tickets = runP4(['tickets'], { cwd })
  const ticketsFailure = p4FailureReason(tickets)
  if (ticketsFailure) throw new Error(`${ticketsFailure}，无法读取 p4 ticket`)
  if (tickets?.status !== 0) throw new Error('p4 tickets 失败，无法读取 p4 ticket')
  const ticket = pickTicketForUser(tickets.stdout, user)
  if (!ticket) {
    throw new Error(`没有找到用户 ${user} 的 p4 ticket，请先在终端执行 p4 login`)
  }
  return { user, basic: buildBasicAuth(user, ticket) }
}

/** API 路径拼接：`<base>/api/<version>/<path>`；base 的尾随斜杠会被去掉。 */
export function buildEndpoint(baseUrl, apiVersion, path) {
  return `${String(baseUrl).replace(/\/+$/, '')}/api/${apiVersion}/${path}`
}

async function requestJson({
  fetchImpl,
  basic,
  baseUrl,
  apiVersion,
  method,
  path,
  body,
  timeoutSignal,
}) {
  const url = buildEndpoint(baseUrl, apiVersion, path)
  const headers = { Authorization: basic, Accept: 'application/json' }
  const init = { method, headers, signal: timeoutSignal() }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  let response
  try {
    response = await fetchImpl(url, init)
  } catch (error) {
    const name = typeof error?.name === 'string' ? error.name : ''
    if (name === 'TimeoutError' || name === 'AbortError' || error?.code === 'ABORT_ERR') {
      throw new Error(`${method} ${path} 请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒）`)
    }
    throw new Error(`${method} ${path} 请求失败（${name || '网络错误'}）`)
  }
  if (!response.ok) throw new SwarmHttpError(method, path, response.status)
  const text = await response.text()
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${method} ${path} 返回的不是合法 JSON`)
  }
}

/** 详情响应可能是 `{ review: {...} }`，也可能是裸 review 对象。 */
export function unwrapReview(raw) {
  const root = raw !== null && typeof raw === 'object' ? raw : {}
  const review = root.review
  return review !== null && typeof review === 'object' ? review : root
}

/** 最新版本号：raw 里通常叫 `rev`（UI DTO 归一成 `version`），兼容两种形态。 */
export function latestReviewVersion(review) {
  const versions = Array.isArray(review?.versions) ? review.versions : []
  for (let i = versions.length - 1; i >= 0; i--) {
    const entry = versions[i]
    const value = entry?.version ?? entry?.rev ?? entry?.difference
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

export function reviewVersionCount(review) {
  return Array.isArray(review?.versions) ? review.versions.length : 0
}

/** transitions 响应是 `{ transitions: { approved: "Approve", ... } }` 或数组。 */
export function transitionStates(raw) {
  const value =
    raw !== null && typeof raw === 'object' && raw.transitions !== undefined ? raw.transitions : raw
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === 'string' ? entry : (entry?.state ?? entry?.key)))
      .filter((state) => typeof state === 'string')
  }
  if (value !== null && typeof value === 'object') return Object.keys(value)
  return []
}

/** 只接受精确的 `approved`；`approved:commit` 不算（本脚本永不提交）。 */
export function canApprove(rawTransitions) {
  return transitionStates(rawTransitions).includes('approved')
}

function truncate(text, limit) {
  const value = String(text ?? '')
  return value.length > limit ? value.slice(0, limit) : value
}

function reviewSummary(raw) {
  const review = unwrapReview(raw)
  const latestVersion = latestReviewVersion(review)
  return {
    id: String(review?.id ?? ''),
    state: String(review?.state ?? ''),
    author: String(review?.author ?? ''),
    description: truncate(review?.description, DESCRIPTION_LIMIT),
    versionCount: reviewVersionCount(review),
    ...(latestVersion === undefined ? {} : { latestVersion }),
  }
}

async function readBody(options, deps) {
  if (options.body !== undefined) return options.body
  const readFile = deps.readFile ?? readFileSync
  try {
    return String(readFile(options.bodyFile, 'utf8'))
  } catch (error) {
    throw new Error(`无法读取 --body-file: ${error.message}`)
  }
}

async function execute(options, deps) {
  const runP4 = deps.runP4 ?? defaultRunP4
  const cwd = deps.cwd ?? process.cwd()
  const env = deps.env ?? process.env
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const timeoutSignal = deps.timeoutSignal ?? (() => AbortSignal.timeout(REQUEST_TIMEOUT_MS))

  const baseUrl = options.url ?? env.UE_SWARM_URL
  if (!baseUrl) {
    throw new UsageError('缺少 Swarm 地址：请用 --url <swarmBase> 或设置 UE_SWARM_URL')
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('当前 Node 没有可用的 fetch（需要 Node 18+）')
  }

  const { basic } = resolveAuth({ runP4, cwd, env, userOverride: options.user })
  const client = {
    fetchImpl,
    basic,
    baseUrl,
    apiVersion: options.apiVersion,
    reviewId: options.reviewId,
    timeoutSignal,
  }
  const reviewPath = `reviews/${encodeURIComponent(options.reviewId)}`

  switch (options.command) {
    case 'get': {
      const detail = await requestJson({ ...client, method: 'GET', path: reviewPath })
      const summary = reviewSummary(detail)
      try {
        const transitions = await requestJson({
          ...client,
          method: 'GET',
          path: `${reviewPath}/transitions`,
        })
        const states = transitionStates(transitions)
        if (states.length > 0) summary.transitions = states
      } catch {
        // transitions 只是辅助信息，取不到不影响 get。
      }
      return summary
    }

    case 'vote': {
      const detail = await requestJson({ ...client, method: 'GET', path: reviewPath })
      const version = latestReviewVersion(unwrapReview(detail))
      const body = { vote: options.vote }
      if (version !== undefined) body.version = version
      await requestJson({ ...client, method: 'POST', path: `${reviewPath}/vote`, body })
      return {
        ok: true,
        command: 'vote',
        reviewId: options.reviewId,
        vote: options.vote,
        ...(version === undefined ? {} : { version }),
      }
    }

    case 'comment': {
      const body = await readBody(options, deps)
      if (body.trim() === '') throw new UsageError('评论正文不能为空')
      const response = await requestJson({
        ...client,
        method: 'POST',
        path: 'comments',
        body: { topic: `reviews/${options.reviewId}`, body },
      })
      const comment = unwrapReview(response?.comment ?? response)
      const commentId = comment?.id
      return {
        ok: true,
        command: 'comment',
        reviewId: options.reviewId,
        ...(commentId === undefined ? {} : { commentId }),
      }
    }

    case 'approve': {
      const transitions = await requestJson({
        ...client,
        method: 'GET',
        path: `${reviewPath}/transitions`,
      })
      if (!canApprove(transitions)) {
        const states = transitionStates(transitions)
        throw new Error(
          `审核 ${options.reviewId} 当前不允许 approved 转换` +
            (states.length > 0 ? `（可用：${states.join(', ')}）` : '') +
            '；未执行 approve',
        )
      }
      await requestJson({
        ...client,
        method: 'PATCH',
        path: `${reviewPath}/state`,
        body: { state: 'approved' },
      })
      return { ok: true, command: 'approve', reviewId: options.reviewId, state: 'approved' }
    }

    default:
      throw new UsageError(`未知子命令: ${options.command}`)
  }
}

/**
 * CLI 入口。返回退出码（0 成功 / 1 运行期错误 / 2 用法错误），不直接设置 process.exitCode，
 * 便于测试与直接调用。
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const stdout = deps.stdout ?? process.stdout
  const stderr = deps.stderr ?? process.stderr

  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    stderr.write(`[swarm] ${error.message}\n`)
    return 2
  }

  if (options.help) {
    stdout.write(usageText())
    return 0
  }

  try {
    const result = await execute(options, deps)
    stdout.write(`${JSON.stringify(result)}\n`)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    stderr.write(`[swarm] ${message}\n`)
    return error instanceof UsageError ? 2 : 1
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

if (invokedDirectly) {
  main().then((code) => {
    if (code !== 0) process.exitCode = code
  })
}
