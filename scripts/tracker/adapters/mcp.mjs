/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  mcp 适配器：远程 Streamable HTTP MCP 客户端（零 npm 依赖）。用于对接自带原生 MCP 的
 *  需求系统：initialize → tools/call，响应兼容 application/json 与 text/event-stream。
 *
 *  token 可由配置里的 token 或环境变量 UE_TRACKER_TOKEN 提供；只放在请求头里，绝不打印。
 *--------------------------------------------------------------------------------------------*/

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import {
  assertCommentBody,
  assertStatus,
  assertTrackerKey,
  isTrackerErrorCode,
  TrackerError,
} from '../contract.mjs'

const PROTOCOL_VERSION = '2025-06-18'
const REQUEST_TIMEOUT_MS = 30_000
const INITIALIZE_TIMEOUT_MS = 15_000
const NOTIFICATION_TIMEOUT_MS = 5_000
const CLIENT_INFO = { name: 'universe-editor-tracker', version: '1.0.0' }

function httpErrorStatus(status) {
  if (status === 401) return new TrackerError('AUTH', 'tracker MCP 鉴权失败（HTTP 401）')
  if (status === 403) return new TrackerError('FORBIDDEN', 'tracker MCP 没有权限（HTTP 403）')
  if (status === 404) return new TrackerError('NOT_FOUND', 'tracker MCP 端点不存在（HTTP 404）')
  if (status === 429)
    return new TrackerError('RATE_LIMITED', 'tracker MCP 请求过于频繁（HTTP 429）')
  if (status === 400 || status === 422)
    return new TrackerError('INVALID', `tracker MCP 请求参数无效（HTTP ${status}）`)
  return new TrackerError('UNAVAILABLE', `tracker MCP 服务不可用（HTTP ${status}）`)
}

function jsonRpcErrorCode(error) {
  if (error?.code === -32600 || error?.code === -32602 || error?.code === -32601) {
    return 'INVALID'
  }
  return 'UNAVAILABLE'
}

function parseSseMessages(text) {
  const messages = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (data.length === 0) continue
    try {
      messages.push(JSON.parse(data.join('\n')))
    } catch {
      // 忽略非 JSON 的心跳/注释事件。
    }
  }
  return messages
}

function pickResponse(messages, id) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (id === undefined) return message
    if (message?.id === id) return message
  }
  return undefined
}

function requestText(url, { body, headers, timeoutMs }) {
  return new Promise((resolvePromise, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      reject(new TrackerError('INVALID', 'tracker MCP 地址无效'))
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

    const payload = Buffer.from(JSON.stringify(body))
    const req = transport(
      parsed,
      {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'content-length': String(payload.length),
          'mcp-protocol-version': PROTOCOL_VERSION,
          ...headers,
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          resolvePromise({
            status: res.statusCode ?? 0,
            contentType: String(res.headers['content-type'] ?? ''),
            text: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )

    req.setTimeout(timeoutMs, () => {
      req.destroy(new TrackerError('UNAVAILABLE', `tracker MCP 请求超时（${timeoutMs}ms）`))
    })
    req.on('error', (error) => {
      reject(error instanceof TrackerError ? error : new TrackerError('UNAVAILABLE', error.message))
    })
    req.write(payload)
    req.end()
  })
}

/**
 * @param {ReturnType<import('../config.mjs').normalizeConfig>} config
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
export function createMcpAdapter(config, { env = process.env } = {}) {
  const url = config.url
  const envToken = env.UE_TRACKER_TOKEN?.trim()
  const token = envToken !== undefined && envToken !== '' ? envToken : config.token

  let nextId = 1
  let initialized = false
  let initializePromise

  async function rpc(message, timeoutMs) {
    const headers = {}
    if (token !== undefined && token !== '') headers.authorization = `Bearer ${token}`
    const response = await requestText(url, { body: message, headers, timeoutMs })
    if (response.status < 200 || response.status >= 300) {
      throw httpErrorStatus(response.status)
    }

    const expectedId = 'id' in message ? message.id : undefined
    let parsed
    if (response.contentType.includes('text/event-stream')) {
      parsed = pickResponse(parseSseMessages(response.text), expectedId)
    } else if (response.text.trim() !== '') {
      try {
        parsed = JSON.parse(response.text)
      } catch {
        throw new TrackerError('UNAVAILABLE', 'tracker MCP 返回了无法解析的 JSON')
      }
    }

    if (expectedId === undefined) return parsed
    if (parsed === undefined) {
      throw new TrackerError('UNAVAILABLE', 'tracker MCP 响应缺少 JSON-RPC 消息')
    }
    if (parsed.error !== undefined) {
      throw new TrackerError(
        jsonRpcErrorCode(parsed.error),
        String(parsed.error.message ?? 'JSON-RPC 错误'),
      )
    }
    return parsed
  }

  async function ensureInitialized() {
    if (initialized) return
    if (initializePromise === undefined) {
      initializePromise = (async () => {
        const response = await rpc(
          {
            jsonrpc: '2.0',
            id: nextId++,
            method: 'initialize',
            params: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: CLIENT_INFO,
            },
          },
          INITIALIZE_TIMEOUT_MS,
        )
        if (typeof response?.result?.protocolVersion !== 'string') {
          throw new TrackerError('UNAVAILABLE', 'tracker MCP initialize 响应缺少 protocolVersion')
        }
        await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, NOTIFICATION_TIMEOUT_MS)
        initialized = true
      })().catch((error) => {
        initializePromise = undefined
        throw error
      })
    }
    return initializePromise
  }

  async function callTool(name, args) {
    await ensureInitialized()
    const response = await rpc(
      {
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name, arguments: args },
      },
      REQUEST_TIMEOUT_MS,
    )
    const result = response?.result
    if (result === undefined) {
      throw new TrackerError('UNAVAILABLE', `tracker MCP 工具 ${name} 没有返回结果`)
    }
    if (result.isError === true) {
      const structured = result.structuredContent
      const code = isTrackerErrorCode(structured?.code) ? structured.code : 'UNAVAILABLE'
      const message = typeof structured?.message === 'string' ? structured.message : '工具调用失败'
      throw new TrackerError(code, message)
    }
    if (result.structuredContent !== undefined) return result.structuredContent
    const text = result.content?.[0]?.text
    if (typeof text === 'string') {
      try {
        return JSON.parse(text)
      } catch {
        throw new TrackerError('UNAVAILABLE', `tracker MCP 工具 ${name} 返回了非 JSON 文本`)
      }
    }
    throw new TrackerError('UNAVAILABLE', `tracker MCP 工具 ${name} 缺少结构化结果`)
  }

  function compact(args) {
    const result = {}
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined) result[key] = value
    }
    return result
  }

  async function getCapabilities() {
    return callTool('get_tracker_capabilities', {})
  }

  async function listRequirements({ project, status, labels, since, limit, cursor } = {}) {
    const result = await callTool(
      'list_requirements',
      compact({ project, status, labels, since, limit, cursor }),
    )
    if (!Array.isArray(result?.items)) {
      throw new TrackerError('UNAVAILABLE', 'tracker MCP list_requirements 缺少 items')
    }
    return compact({ items: result.items, nextCursor: result.nextCursor })
  }

  async function getRequirement({ id } = {}) {
    return callTool('get_requirement', compact({ id }))
  }

  async function claimRequirement({ id, runId, idempotencyKey } = {}) {
    assertTrackerKey(runId, 'runId')
    assertTrackerKey(idempotencyKey, 'idempotencyKey')
    return callTool('claim_requirement', compact({ id, runId, idempotencyKey }))
  }

  async function commentRequirement({ id, body, idempotencyKey } = {}) {
    assertCommentBody(body)
    assertTrackerKey(idempotencyKey, 'idempotencyKey')
    return callTool('comment_requirement', compact({ id, body, idempotencyKey }))
  }

  async function transitionRequirement({ id, to, idempotencyKey, comment } = {}) {
    assertStatus(to)
    assertTrackerKey(idempotencyKey, 'idempotencyKey')
    if (comment !== undefined) assertCommentBody(comment)
    return callTool('transition_requirement', compact({ id, to, idempotencyKey, comment }))
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
