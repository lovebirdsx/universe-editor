/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  board 型 tracker 适配器：把具体系统的 REST API 映射成 tracker 契约 v1
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

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import {
  assertCommentBody,
  assertStatus,
  assertTrackerKey,
  claimMarker,
  decodeCursor,
  encodeCursor,
  extractClaimRunIds,
  hasIdempotencyMarker,
  idempotencyMarker,
  MAX_RECENT_COMMENTS,
  parseLimit,
  parseSince,
  stripTrackerMarkers,
  TrackerError,
  UNIFIED_STATUSES,
  TRACKER_CONTRACT_VERSION,
} from '../contract.mjs'

export { TrackerError } from '../contract.mjs'

const HTTP_TIMEOUT_MS = 15_000

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

export function toRequirementStatus(postStatus) {
  return REQUIREMENT_STATUS_BY_POST.get(String(postStatus)) ?? 'open'
}

export function toPostStatus(status) {
  const statuses = POST_STATUS_BY_REQUIREMENT[status]
  if (!statuses) throw new TrackerError('INVALID', `未知需求状态 ${status}`)
  // 统一状态到具体状态不是一一对应：open 优先取 Open；写入时 UnderReview 仍归入 open。
  return statuses[0]
}

export function postStatusesFor(status) {
  const statuses = POST_STATUS_BY_REQUIREMENT[status]
  if (!statuses) throw new TrackerError('INVALID', `未知需求状态 ${status}`)
  return statuses
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
  if (status === 401) return new TrackerError('AUTH', '鉴权失败（HTTP 401）')
  if (status === 403) return new TrackerError('FORBIDDEN', '没有权限（HTTP 403）')
  if (status === 409) return new TrackerError('CONFLICT', '资源状态冲突')
  if (status === 429) return new TrackerError('RATE_LIMITED', '请求过于频繁（HTTP 429）')
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

function userRef(id, users) {
  if (id === undefined || id === null || id === '') return null
  const key = String(id)
  return { id: key, name: users.get(key) ?? null }
}

/**
 * @param {ReturnType<import('../config.mjs').normalizeConfig>} config
 */
export function createBoardAdapter(config) {
  const state = {
    token: undefined,
    board: undefined,
    boards: undefined,
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

  async function listBoards(force = false) {
    if (state.boards && !force) return state.boards
    state.boards = asArray(await publicJson('board/not-deleted'))
    return state.boards
  }

  async function getBoard() {
    if (state.board) return state.board
    const boards = await listBoards()
    const board = boards.find((item) => item?.name === config.board)
    if (!board) throw new TrackerError('NOT_FOUND', `未找到看板 ${config.board}`)
    state.board = board
    return board
  }

  async function resolveBoard(project) {
    if (project === undefined) return getBoard()
    const boards = await listBoards()
    const byId = boards.find((item) => String(item?._id) === String(project))
    if (byId) return byId
    const byName = boards.filter((item) => item?.name === project)
    if (byName.length === 0) throw new TrackerError('NOT_FOUND', `看板 ${project} 不存在`)
    return byName[0]
  }

  function tagNames(board) {
    const names = new Map()
    for (const tag of board?.tags ?? []) {
      if (tag?._id !== undefined) names.set(String(tag._id), tag.name)
    }
    return names
  }

  function tagIdsFor(board, names) {
    const byName = new Map()
    for (const tag of board?.tags ?? []) {
      if (tag?.name !== undefined) byName.set(tag.name, String(tag._id))
    }
    const ids = []
    for (const name of names) {
      const id = byName.get(name)
      if (id === undefined) return undefined
      ids.push(id)
    }
    return ids
  }

  function requirementUrl(post) {
    if (config.webUrl === undefined) return undefined
    return `${config.webUrl}/posts/${String(post._id)}`
  }

  function summary(post, board) {
    const names = tagNames(board)
    const result = { id: String(post._id), title: String(post.title ?? '') }
    result.status = toRequirementStatus(post.status)
    result.labels = (post.tags ?? [])
      .map((tag) => names.get(String(tag)))
      .filter((name) => name !== undefined)
    if (board?.name !== undefined) result.project = String(board.name)
    if (typeof post.priority === 'number') result.priority = post.priority
    if (typeof post.effort === 'number') result.effort = post.effort
    result.createdAt = isoDate(post.createdAt)
    const url = requirementUrl(post)
    if (url !== undefined) result.url = url
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
    if (post.deletedAt !== undefined && post.deletedAt !== null) {
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

  async function addComment(postId, content, op) {
    const body = { post: String(postId), content }
    if (op !== undefined) body.op = op
    return authedJson('posts/add-comment', { method: 'POST', body })
  }

  async function getCapabilities() {
    const boards = await listBoards()
    return {
      contractVersion: TRACKER_CONTRACT_VERSION,
      tracker: 'board',
      statuses: [...UNIFIED_STATUSES],
      claim: 'best-effort',
      projects: boards.map((board) => ({ id: String(board._id), name: String(board.name) })),
    }
  }

  async function listRequirements({ project, status, labels, since, limit, cursor } = {}) {
    const board = await resolveBoard(project)
    const requestedStatuses = Array.isArray(status) && status.length > 0 ? status : [undefined]
    for (const requirementStatus of requestedStatuses) {
      if (requirementStatus !== undefined) assertStatus(requirementStatus)
    }
    const requestedLabels = Array.isArray(labels) ? labels : []
    const tagIdsForLabels = requestedLabels.length > 0 ? tagIdsFor(board, requestedLabels) : []
    if (requestedLabels.length > 0 && tagIdsForLabels === undefined) {
      return { items: [] }
    }
    const sinceDate = parseSince(since)
    const pageSize = parseLimit(limit)
    const skip = cursor === undefined ? 0 : decodeCursor(cursor)

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
        if (tagIdsForLabels !== undefined && tagIdsForLabels.length > 0) {
          body.tags = tagIdsForLabels
        }
        posts.push(...asArray(await publicJson('posts/by-board', { method: 'POST', body })))
      }
    }

    const byId = new Map()
    for (const post of posts) {
      if (post?._id !== undefined) byId.set(String(post._id), post)
    }
    let matched = [...byId.values()]
    if (tagIdsForLabels !== undefined && tagIdsForLabels.length > 0) {
      // 契约要求 labels 全部包含；REST 的 tags 过滤语义不保证，这里再收一次。
      matched = matched.filter((post) =>
        tagIdsForLabels.every((tagId) => (post.tags ?? []).some((tag) => String(tag) === tagId)),
      )
    }
    if (sinceDate !== undefined) {
      matched = matched.filter((post) => new Date(post.createdAt).getTime() >= sinceDate.getTime())
    }
    matched.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
        String(b._id).localeCompare(String(a._id)),
    )

    const page = matched.slice(skip, skip + pageSize)
    const result = { items: page.map((post) => summary(post, board)) }
    if (skip + pageSize < matched.length) result.nextCursor = encodeCursor(skip + pageSize)
    return result
  }

  async function getRequirement({ id } = {}) {
    const post = await fetchPost(id)
    const board = (await listBoards()).find((item) => String(item?._id) === String(post.board))
    if (!board) throw new TrackerError('NOT_FOUND', `需求 ${id} 所属看板不存在`)
    const [comments, users] = await Promise.all([fetchComments(id), loadUsers()])

    const recent = comments
      .slice()
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .slice(-MAX_RECENT_COMMENTS)
      .map((comment) => ({
        id: String(comment._id ?? ''),
        author: userRef(comment.createdBy, users),
        body: stripTrackerMarkers(comment.content),
        createdAt: isoDate(comment.createdAt),
      }))

    const assignees = []
    for (const [role, field] of [
      ['owner', 'owner'],
      ['td', 'td'],
      ['devFe', 'devFe'],
      ['devBe', 'devBe'],
    ]) {
      const ref = userRef(post[field], users)
      if (ref !== null) assignees.push({ ...ref, role })
    }

    return {
      ...summary(post, board),
      body: typeof post.content === 'string' ? post.content : '',
      author: userRef(post.createdBy, users),
      assignees,
      attachments: (post.attachments ?? []).map((attachment) => {
        const item = {
          name: String(attachment.name ?? ''),
          url: joinUrl(config.baseUrl, attachment.path ?? ''),
        }
        if (typeof attachment.size === 'number') item.size = attachment.size
        return item
      }),
      comments: recent,
    }
  }

  async function claimRequirement({ id, runId, idempotencyKey } = {}) {
    assertTrackerKey(runId, 'runId')
    assertTrackerKey(idempotencyKey, 'idempotencyKey')
    const post = await fetchPost(id)
    const current = toRequirementStatus(post.status)
    const comments = await fetchComments(id)
    const claimedRunIds = comments.flatMap((comment) => extractClaimRunIds(comment.content))

    if (claimedRunIds.includes(runId)) {
      return { claimed: true, claimedBy: runId, status: current }
    }
    const otherRunId = claimedRunIds[0]
    if (otherRunId && current === 'in_progress') {
      return { claimed: false, claimedBy: otherRunId, status: current }
    }
    if (current === 'done' || current === 'closed') {
      throw new TrackerError('CONFLICT', `需求 ${id} 已处于 ${current} 状态，无法认领`)
    }

    // 声明是 best-effort：读取与写入之间没有分布式锁，极小概率会双重认领。
    await addComment(
      post._id,
      [
        `自动化流程已认领该需求（runId: ${runId}）。`,
        claimMarker(runId),
        idempotencyMarker(idempotencyKey),
      ].join('\n\n'),
      { type: 'changePostStatus', postStatus: 'InProgress' },
    )
    return { claimed: true, claimedBy: runId, status: 'in_progress' }
  }

  async function commentRequirement({ id, body, idempotencyKey } = {}) {
    assertCommentBody(body)
    assertTrackerKey(idempotencyKey, 'idempotencyKey')
    const post = await fetchPost(id)
    const comments = await fetchComments(id)
    const existing = comments.find((comment) =>
      hasIdempotencyMarker(comment.content, idempotencyKey),
    )
    if (existing) {
      return { commentId: String(existing._id ?? ''), duplicate: true }
    }
    const created = await addComment(post._id, `${body}\n\n${idempotencyMarker(idempotencyKey)}`)
    return { commentId: String(created?._id ?? ''), duplicate: false }
  }

  async function transitionRequirement({ id, to, idempotencyKey, comment } = {}) {
    assertStatus(to)
    assertTrackerKey(idempotencyKey, 'idempotencyKey')
    if (comment !== undefined) assertCommentBody(comment)

    const post = await fetchPost(id)
    const from = toRequirementStatus(post.status)
    if (from === to) return { from, to, changed: false }

    const comments = await fetchComments(id)
    if (comments.some((item) => hasIdempotencyMarker(item.content, idempotencyKey))) {
      return { from, to, changed: false }
    }

    const note = comment?.trim() ? comment : `需求状态由「${from}」变更为「${to}」`
    await addComment(post._id, `${note}\n\n${idempotencyMarker(idempotencyKey)}`, {
      type: 'changePostStatus',
      postStatus: toPostStatus(to),
    })
    return { from, to, changed: true }
  }

  return {
    getCapabilities,
    listRequirements,
    getRequirement,
    claimRequirement,
    commentRequirement,
    transitionRequirement,
  }
}
