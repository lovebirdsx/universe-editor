/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  MCP 协议端到端测试：spawn `serve`，经换行分隔 JSON-RPC 走
 *  initialize → tools/list → tools/call，并验证 `list` 子命令的 poll 输出。
 *  工具名/入参/出参按 tracker 契约 v1 断言。
 *--------------------------------------------------------------------------------------------*/

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkTempDir, removeDirWithRetry } from '../../lib/temp-root.mjs'
import { resetBoardState, startFakeBoard, TEST_PASSWORD, TEST_USERNAME } from './fake-board.mjs'

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'tracker-mcp.mjs')

let fake
let tempDir
let configPath
let server

function startMcpServer() {
  const child = spawn(process.execPath, [SCRIPT, 'serve'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, UE_TRACKER_CONFIG: configPath },
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  let buffer = ''
  let stderr = ''
  const waiters = new Map()

  child.stdout.on('data', (chunk) => {
    buffer += chunk
    for (;;) {
      const index = buffer.indexOf('\n')
      if (index < 0) break
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim() === '') continue
      const message = JSON.parse(line)
      const waiter = waiters.get(message.id)
      if (waiter) {
        waiters.delete(message.id)
        waiter({ message })
      }
    }
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  function request(message) {
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(message.id)
        reject(new Error(`MCP 响应超时；stderr=${stderr}`))
      }, 5000)
      waiters.set(message.id, ({ message: response }) => {
        clearTimeout(timer)
        resolvePromise(response)
      })
      child.stdin.write(`${JSON.stringify(message)}\n`)
    })
  }

  function notify(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  return {
    request,
    notify,
    getStderr: () => stderr,
    stop: () =>
      new Promise((resolvePromise) => {
        child.once('exit', resolvePromise)
        child.stdin.end()
        setTimeout(() => child.kill(), 2000)
      }),
  }
}

before(async () => {
  fake = await startFakeBoard()
  tempDir = mkTempDir('tracker-test-')
  configPath = join(tempDir, 'tracker.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      adapter: 'board',
      baseUrl: fake.url,
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      board: 'universe-editor',
      webUrl: 'https://tracker.example.com',
      eligible: { labels: ['ai-ready'], statuses: ['planned'] },
    }),
  )
  server = startMcpServer()
})

after(async () => {
  await server.stop()
  await fake.close()
  removeDirWithRetry(tempDir)
})

beforeEach(() => {
  resetBoardState(fake.state)
})

test('initialize 返回协议版本、tools 能力与 serverInfo', async () => {
  const response = await server.request({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
  })

  assert.equal(response.result.protocolVersion, '2025-06-18')
  assert.deepEqual(response.result.capabilities, { tools: { listChanged: false } })
  assert.deepEqual(response.result.serverInfo, { name: 'tracker', version: '1.0.0' })
})

test('notifications/initialized 无响应；tools/list 暴露契约 v1 工具', async () => {
  server.notify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const response = await server.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' })

  assert.deepEqual(response.result.tools.map((tool) => tool.name).sort(), [
    'claim_requirement',
    'comment_requirement',
    'get_requirement',
    'get_tracker_capabilities',
    'list_requirements',
    'transition_requirement',
  ])
  assert.equal(
    response.result.tools.every((tool) => tool.inputSchema.type === 'object'),
    true,
  )

  const claim = response.result.tools.find((tool) => tool.name === 'claim_requirement')
  assert.deepEqual(claim.inputSchema.required, ['id', 'runId', 'idempotencyKey'])
})

test('ping 返回空结果', async () => {
  const response = await server.request({ jsonrpc: '2.0', id: 3, method: 'ping' })
  assert.deepEqual(response.result, {})
})

test('tools/call get_tracker_capabilities', async () => {
  const response = await server.request({
    jsonrpc: '2.0',
    id: 31,
    method: 'tools/call',
    params: { name: 'get_tracker_capabilities' },
  })

  const result = response.result.structuredContent
  assert.equal(result.contractVersion, 1)
  assert.equal(result.claim, 'best-effort')
  assert.deepEqual(result.projects, [{ id: 'board-1', name: 'universe-editor' }])
  assert.deepEqual(JSON.parse(response.result.content[0].text), result)
})

test('tools/call list_requirements：content 与 structuredContent 一致', async () => {
  const response = await server.request({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'list_requirements',
      arguments: { status: ['planned'], labels: ['ai-ready'] },
    },
  })

  assert.equal(response.result.isError, undefined)
  assert.deepEqual(
    response.result.structuredContent.items.map((item) => item.id),
    ['p1'],
  )
  assert.deepEqual(JSON.parse(response.result.content[0].text), response.result.structuredContent)
})

test('tools/call list_requirements：不传参数时使用 eligible 默认过滤', async () => {
  const response = await server.request({
    jsonrpc: '2.0',
    id: 41,
    method: 'tools/call',
    params: { name: 'list_requirements' },
  })

  assert.deepEqual(
    response.result.structuredContent.items.map((item) => item.id),
    ['p1'],
  )
})

test('tools/call get_requirement：正文/作者/附件/最近评论', async () => {
  const response = await server.request({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'get_requirement', arguments: { id: 'p1' } },
  })

  const requirement = response.result.structuredContent
  assert.equal(requirement.title, 'Add widget')
  assert.match(requirement.body, /Widget spec/)
  assert.deepEqual(requirement.author, { id: 'u1', name: 'alice' })
  assert.equal(requirement.attachments[0].name, 'spec.md')
  assert.deepEqual(
    requirement.comments.map((comment) => comment.author.name),
    ['alice', 'bob'],
  )
})

test('tools/call claim / comment / transition 写链路（claimed / duplicate / changed）', async () => {
  const claim = await server.request({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: {
      name: 'claim_requirement',
      arguments: { id: 'p5', runId: 'mcp-run-1', idempotencyKey: 'mcp-run-1:claim' },
    },
  })
  assert.deepEqual(claim.result.structuredContent, {
    claimed: true,
    claimedBy: 'mcp-run-1',
    status: 'in_progress',
  })
  assert.equal(fake.state.posts.find((post) => post._id === 'p5').status, 'InProgress')

  const comment = await server.request({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name: 'comment_requirement',
      arguments: { id: 'p5', body: '开始处理', idempotencyKey: 'mcp-run-1:claim-ack' },
    },
  })
  assert.equal(comment.result.structuredContent.duplicate, false)

  const duplicate = await server.request({
    jsonrpc: '2.0',
    id: 71,
    method: 'tools/call',
    params: {
      name: 'comment_requirement',
      arguments: { id: 'p5', body: '开始处理', idempotencyKey: 'mcp-run-1:claim-ack' },
    },
  })
  assert.equal(duplicate.result.structuredContent.duplicate, true)

  const transition = await server.request({
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: {
      name: 'transition_requirement',
      arguments: { id: 'p5', to: 'done', idempotencyKey: 'mcp-run-1:result' },
    },
  })
  assert.deepEqual(transition.result.structuredContent, {
    from: 'in_progress',
    to: 'done',
    changed: true,
  })
})

test('工具错误返回 isError + structuredContent.code', async () => {
  const notFound = await server.request({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: { name: 'get_requirement', arguments: { id: 'missing' } },
  })
  assert.equal(notFound.result.isError, true)
  assert.equal(notFound.result.structuredContent.code, 'NOT_FOUND')
  assert.deepEqual(JSON.parse(notFound.result.content[0].text), {
    code: 'NOT_FOUND',
    message: notFound.result.structuredContent.message,
  })

  const invalid = await server.request({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: {
      name: 'transition_requirement',
      arguments: { id: 'p1', to: 'nope', idempotencyKey: 'run-1:x' },
    },
  })
  assert.equal(invalid.result.structuredContent.code, 'INVALID')

  const conflict = await server.request({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: {
      name: 'claim_requirement',
      arguments: { id: 'p3', runId: 'run-1', idempotencyKey: 'run-1:claim' },
    },
  })
  assert.equal(conflict.result.structuredContent.code, 'CONFLICT')

  const badLimit = await server.request({
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: { name: 'list_requirements', arguments: { limit: 1000 } },
  })
  assert.equal(badLimit.result.structuredContent.code, 'INVALID')
})

test('未知方法返回 -32601', async () => {
  const response = await server.request({ jsonrpc: '2.0', id: 13, method: 'nope/method' })
  assert.equal(response.error.code, -32601)
})

function runList() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [SCRIPT, 'list'], {
      env: { ...process.env, UE_TRACKER_CONFIG: configPath },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }))
  })
}

test('list 子命令输出 poll 用的轻量数组，且不泄露密码', async () => {
  const result = await runList()

  assert.equal(result.status, 0, result.stderr)
  const items = JSON.parse(result.stdout)
  assert.deepEqual(
    items.map((item) => item.id),
    ['p1'],
  )
  assert.equal(items[0].project, 'universe-editor')
  assert.equal(result.stderr, '')
  assert.ok(!result.stdout.includes(TEST_PASSWORD))
  assert.ok(!result.stderr.includes(TEST_PASSWORD))
})
