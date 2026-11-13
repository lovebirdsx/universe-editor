/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  board 型 tracker 适配器：把具体系统的 REST API 映射成 tracker 工具契约
 *  （open / planned / in_progress / done / closed）。协议与分派在 tracker-mcp.mjs，
 *  这里只负责 HTTP、登录缓存与字段映射。
 *
 *  API 事实按源码核对过：
 *    - GET  /board/not-deleted            公开，返回看板数组（含 tags[{_id,name}]）
 *    - POST /posts/by-board               公开，DTO：{board,status?,tags?,limit?,sortBy?,sortOrder?,deleteType?}
 *    - GET  /posts/:id                    公开；GET /posts/:id/comments 公开
 *    - GET  /users                        公开，用于把评论作者 id 映射成 username
 *    - POST /auth/local                   登录，body 走 passport-local 默认字段 username/password
 *    - POST /posts/add-comment            鉴权只读 Cookie: jwt=<accessToken>；op 改状态
 *  登录响应只返回 {accessToken}，不 Set-Cookie，因此由本适配器自己拼 Cookie 头。
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

export const MAX_RECENT_COMMENTS = 20
const HTTP_TIMEOUT_MS = 15_000
const DEFAULT_CLAIM_PREFIX = 'bot'

const POST_STATUS_BY_REQUIREMENT = {
  open: ['Open', 'UnderReview'],
  planned: ['Planned'],
  in_progress: ['InProgress'],
  done: ['Complete'],
  closed: ['Closed'],
}

const REQUIREMENT_STATUS_BY_POST = new Map([
  ['Open', 'open'],
  ['UnderReview', 'open'],
  ['Planned', 'planned'],
  ['InProgress', 'in_progress'],
  ['Complete', 'done'],
  ['Closed', 'closed'],
])

export class TrackerError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TrackerError'
    this.code = code
  }
}

export function toRequirementStatus(postStatus) {
  return REQUIREMENT_STATUS_BY_POST.get(String(postStatus)) ?? 'open'
}

export function toPostStatus(status) {
  const statuses = POST_STATUS_BY_REQUIREMENT[status]
  if (!statuses) {
    throw new TrackerError(
      'INVALID',
      `未知需求状态 ${status}（允许：${Object.keys(POST_STATUS_BY_REQUIREMENT).join('/')}）`,
    )
  }
  // 统一状态到具体状态不是一一对应：open 优先取 Open；写入时 UnderReview 仍归入 open。
  return statuses[0]
}

export function postStatusesFor(status) {
  const statuses = POST_STATUS_BY_REQUIREMENT[status]
  if (!statuses) {
    throw new TrackerError(
      'INVALID',
      `未知需求状态 ${status}（允许：${Object.keys(POST_STATUS_BY_REQUIREMENT).join('/')}）`,
    )
  }
  return statuses
}

export function stripTrackerMarkers(content) {
  if (typeof content !== 'string' || content === '') return ''
  return content
    .replace(/<!-- tracker-claim:[^>\s]+ -->/g, '')
    .replace(/<!-- tracker-idem:[^>\s]+ -->/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function joinUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`
}

function asArray(value) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.items)) return value.items
  return []
}

function isoDate(value) {
  if (typeof value === 'string' && value !== '') return value
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString()
}

function statusCodeError(status) {
  if (status === 404) return new TrackerError('NOT_FOUND', '需求或资源不存在')
  if (status === 401 || status === 403)
    return new TrackerError('AUTH', `鉴权失败（HTTP ${status}）`)
  if (status === 409) return new TrackerError('CONFLICT', '资源状态冲突')
  if (status === 400 || status === 422)
    return new TrackerError('INVALID', `请求参数无效（HTTP ${status}）`)
  return new TrackerError('UNAVAILABLE', `tracker 服务不可用（HTTP ${status}）`)
}

function requestJson(
  url,
  { method = 'GET', body, headers = {}, timeoutMs = HTTP_TIMEOUT_MS } = {},
) {
  return new Promise((resolvePromise, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      reject(new TrackerError('INVALID', 'tracker 地址无效'))
      return
    }

    const transport =
      parsed.protocol === 'https:'
        ? httpsRequest
        : parsed.protocol === 'http:'
          ? httpRequest
          : undefined
    if (!transport) {
      reject(new TrackerError('INVALID', `不支持的协议 ${parsed.protocol}`))
      return
    }

    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const requestHeaders = { accept: 'application/json', ...headers }
    if (payload !== undefined) {
      requestHeaders['content-type'] = 'application/json'
      requestHeaders['content-length'] = String(payload.length)
    }

    const req = transport(parsed, { method, headers: requestHeaders }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json
        if (text.trim() !== '') {
          try {
            json = JSON.parse(text)
          } catch {
            json = undefined
          }
        }
        resolvePromise({ status: res.statusCode ?? 0, json, text })
      })
    })

    req.setTimeout(timeoutMs, () => {
      req.destroy(new TrackerError('UNAVAILABLE', `tracker 请求超时（${timeoutMs}ms）`))
    })
    req.on('error', (error) => {
      reject(error instanceof TrackerError ? error : new TrackerError('UNAVAILABLE', error.message))
    })
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

function ensureOk(response) {
  if (response.status >= 200 && response.status < 300) return response
  throw statusCodeError(response.status)
}

function makeRunId() {
  return `${DEFAULT_CLAIM_PREFIX}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

/**
 * @param {ReturnType<import('../config.mjs').normalizeConfig>} config
 */
export function createBoardAdapter(config) {
  const state = {
    token: undefined,
    board: undefined,
    users: new Map(),
    usersLoaded: false,
  }

  const api = (path) => joinUrl(config.baseUrl, path)

  async function publicJson(path, options) {
    return ensureOk(await requestJson(api(path), options)).json
  }

  async function login() {
    if (config.username === undefined || config.password === undefined) {
      throw new TrackerError('AUTH', '写操作需要 tracker 配置中的 username/password')
    }
    // passport-local 默认字段是 username/password（源码里 validate(name, pwd) 的形参名有误导性）。
    const response = await requestJson(api('auth/local'), {
      method: 'POST',
      body: { username: config.username, password: config.password },
    })
    if (response.status === 401 || response.status === 403) {
      throw new TrackerError('AUTH', 'tracker 登录失败')
    }
    ensureOk(response)
    const token = response.json?.accessToken
    if (typeof token !== 'string' || token === '') {
      throw new TrackerError('AUTH', 'tracker 登录响应缺少 accessToken')
    }
    return token
  }

  async function ensureToken() {
    if (state.token === undefined) state.token = await login()
    return state.token
  }

  async function authedResponse(path, options) {
    const token = await ensureToken()
    return requestJson(api(path), {
      ...options,
      headers: { ...(options?.headers ?? {}), cookie: `jwt=${token}` },
    })
  }

  async function authedJson(path, options) {
    let response = await authedResponse(path, options)
    if (response.status === 401) {
      // token 过期 / 服务端重启：清缓存重登一次，不重试第二次。
      state.token = undefined
      response = await authedResponse(path, options)
    }
    return ensureOk(response).json
  }

  async function getBoard(force = false) {
    if (state.board && !force) return state.board
    const boards = asArray(await publicJson('board/not-deleted'))
    const board = boards.find((item) => item?.name === config.board)
    if (!board) throw new TrackerError('NOT_FOUND', `未找到看板 ${config.board}`)
    state.board = board
    return board
  }

  function tagNames() {
    const names = new Map()
    for (const tag of state.board?.tags ?? []) {
      if (tag?._id !== undefined) names.set(String(tag._id), tag.name)
    }
    return names
  }

  function tagIds(names) {
    const byName = new Map()
    for (const tag of state.board?.tags ?? []) {
      if (tag?.name !== undefined) byName.set(tag.name, String(tag._id))
    }
    return names.map((name) => byName.get(name)).filter((id) => id !== undefined)
  }

  function requirementUrl(post) {
    if (config.webUrl === undefined) return undefined
    return `${config.webUrl}/posts/${String(post._id)}`
  }

  function summary(post) {
    const names = tagNames()
    const result = { id: String(post._id), title: String(post.title ?? '') }
    const url = requirementUrl(post)
    if (url !== undefined) result.url = url
    result.status = toRequirementStatus(post.status)
    result.labels = (post.tags ?? []).map((tag) => names.get(String(tag))).filter(Boolean)
    if (typeof post.priority === 'number') result.priority = post.priority
    if (typeof post.effort === 'number') result.effort = post.effort
    result.createdAt = isoDate(post.createdAt)
    return result
  }

  async function fetchPost(id) {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new TrackerError('INVALID', 'id 必须是非空字符串')
    }
    const post = await publicJson(`posts/${encodeURIComponent(id)}`)
    if (typeof post !== 'object' || post === null || Array.isArray(post)) {
      throw new TrackerError('NOT_FOUND', `需求 ${id} 不存在`)
    }
    return post
  }

  async function fetchComments(id) {
    return asArray(await publicJson(`posts/${encodeURIComponent(id)}/comments`))
  }

  async function loadUsers() {
    if (state.usersLoaded) return state.users
    state.usersLoaded = true
    try {
      for (const user of asArray(await publicJson('users'))) {
        if (user?._id !== undefined) {
          state.users.set(String(user._id), String(user.username ?? user._id))
        }
      }
    } catch {
      // 用户目录是可选增强；失败时评论作者退化为 id。
    }
    return state.users
  }

  async function listRequirements({ status, labels, limit } = {}) {
    const board = await getBoard()
    const requestedStatuses = Array.isArray(status) && status.length > 0 ? status : [undefined]
    const requestedLabels = Array.isArray(labels) ? labels : []
    const tagIdsForLabels = requestedLabels.length > 0 ? tagIds(requestedLabels) : []
    if (requestedLabels.length > 0 && tagIdsForLabels.length === 0) return []

    const posts = []
    for (const requirementStatus of requestedStatuses) {
      const postStatuses =
        requirementStatus === undefined ? [undefined] : postStatusesFor(requirementStatus)
      for (const postStatus of postStatuses) {
        const body = {
          board: String(board._id),
          sortBy: 'createdAt',
          sortOrder: 'DESC',
          deleteType: 'notDeleted',
        }
        if (postStatus !== undefined) body.status = postStatus
        if (tagIdsForLabels.length > 0) body.tags = tagIdsForLabels
        if (typeof limit === 'number') body.limit = limit
        posts.push(...asArray(await publicJson('posts/by-board', { method: 'POST', body })))
      }
    }

    const byId = new Map()
    for (const post of posts) {
      if (post?._id !== undefined) byId.set(String(post._id), post)
    }
    const sorted = [...byId.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    const limited = typeof limit === 'number' ? sorted.slice(0, limit) : sorted
    return limited.map(summary)
  }

  async function getRequirement({ id } = {}) {
    await getBoard()
    const [post, comments, users] = await Promise.all([
      fetchPost(id),
      fetchComments(id),
      loadUsers(),
    ])

    const recent = comments
      .slice()
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .slice(-MAX_RECENT_COMMENTS)
      .map((comment) => ({
        author: users.get(String(comment.createdBy)) ?? String(comment.createdBy ?? ''),
        body: stripTrackerMarkers(comment.content),
        createdAt: isoDate(comment.createdAt),
      }))

    return {
      ...summary(post),
      body: typeof post.content === 'string' ? post.content : '',
      attachments: (post.attachments ?? []).map((attachment) => ({
        name: String(attachment.name ?? ''),
        url: joinUrl(config.baseUrl, attachment.path ?? ''),
      })),
      comments: recent,
    }
  }

  async function claim({ id, runId } = {}) {
    const post = await fetchPost(id)
    const current = toRequirementStatus(post.status)
    const comments = await fetchComments(id)

    const markers = comments
      .map((comment) => /<!-- tracker-claim:([^>\s]+) -->/.exec(comment.content ?? ''))
      .filter((match) => match !== null)
      .map((match) => match[1])

    if (current === 'in_progress' || current === 'done' || current === 'closed') {
      return markers.length > 0
        ? { ok: false, claimedBy: markers[markers.length - 1] }
        : { ok: false }
    }

    const effectiveRunId =
      typeof runId === 'string' && runId.trim() !== '' ? runId.trim() : makeRunId()
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(effectiveRunId)) {
      throw new TrackerError('INVALID', 'runId 必须为 1-128 个 [A-Za-z0-9._:-] 字符')
    }

    // 声明是 best-effort：读取与写入之间没有分布式锁，极小概率会双重认领。
    await authedJson('posts/add-comment', {
      method: 'POST',
      body: {
        post: String(post._id),
        content: [
          `自动化流程已认领该需求（runId: ${effectiveRunId}）。`,
          `<!-- tracker-claim:${effectiveRunId} -->`,
        ].join('\n\n'),
        op: { type: 'changePostStatus', postStatus: 'InProgress' },
      },
    })
    return { ok: true, claimedBy: effectiveRunId }
  }

  async function comment({ id, body } = {}) {
    if (typeof body !== 'string' || body.trim() === '') {
      throw new TrackerError('INVALID', 'body 必须是非空字符串')
    }
    const post = await fetchPost(id)
    await authedJson('posts/add-comment', {
      method: 'POST',
      body: { post: String(post._id), content: body },
    })
    return { ok: true }
  }

  async function transition({ id, to } = {}) {
    if (typeof to !== 'string') throw new TrackerError('INVALID', 'to 必须是需求状态字符串')
    const post = await fetchPost(id)
    const from = toRequirementStatus(post.status)
    if (from === to) return { ok: true, from, to }
    const postStatus = toPostStatus(to)
    await authedJson('posts/add-comment', {
      method: 'POST',
      body: {
        post: String(post._id),
        content: `需求状态由「${from}」变更为「${to}」。`,
        op: { type: 'changePostStatus', postStatus },
      },
    })
    return { ok: true, from, to }
  }

  return { listRequirements, getRequirement, claim, comment, transition }
}
