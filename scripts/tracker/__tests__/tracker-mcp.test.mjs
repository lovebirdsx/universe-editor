/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  MCP 协议端到端测试：spawn `serve`，经换行分隔 JSON-RPC 走
 *  initialize → tools/list → tools/call，并验证 `list` 子命令的 poll 输出。
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
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } },
  })

  assert.equal(response.result.protocolVersion, '2024-11-05')
  assert.deepEqual(response.result.capabilities, { tools: { listChanged: false } })
  assert.deepEqual(response.result.serverInfo, { name: 'tracker', version: '0.1.0' })
})

test('notifications/initialized 无响应；tools/list 暴露标准工具契约', async () => {
  server.notify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const response = await server.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' })

  assert.deepEqual(response.result.tools.map((tool) => tool.name).sort(), [
    'claim',
    'comment',
    'get_requirement',
    'list_requirements',
    'transition',
  ])
  assert.equal(
    response.result.tools.every((tool) => tool.inputSchema.type === 'object'),
    true,
  )
})

test('ping 返回空结果', async () => {
  const response = await server.request({ jsonrpc: '2.0', id: 3, method: 'ping' })
  assert.deepEqual(response.result, {})
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

test('tools/call get_requirement：正文/附件/最近评论', async () => {
  const response = await server.request({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'get_requirement', arguments: { id: 'p1' } },
  })

  const requirement = response.result.structuredContent
  assert.equal(requirement.title, 'Add widget')
  assert.match(requirement.body, /Widget spec/)
  assert.equal(requirement.attachments[0].name, 'spec.md')
  assert.deepEqual(
    requirement.comments.map((comment) => comment.author),
    ['alice', 'bob'],
  )
})

test('tools/call claim / comment / transition 写链路', async () => {
  const claim = await server.request({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'claim', arguments: { id: 'p5', runId: 'mcp-run-1' } },
  })
  assert.deepEqual(claim.result.structuredContent, { ok: true, claimedBy: 'mcp-run-1' })
  assert.equal(fake.state.posts.find((post) => post._id === 'p5').status, 'InProgress')

  const comment = await server.request({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'comment', arguments: { id: 'p5', body: '开始处理' } },
  })
  assert.deepEqual(comment.result.structuredContent, { ok: true })

  const transition = await server.request({
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: { name: 'transition', arguments: { id: 'p5', to: 'done' } },
  })
  assert.deepEqual(transition.result.structuredContent, {
    ok: true,
    from: 'in_progress',
    to: 'done',
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

  const invalid = await server.request({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: { name: 'transition', arguments: { id: 'p1', to: 'nope' } },
  })
  assert.equal(invalid.result.structuredContent.code, 'INVALID')
})

test('未知方法返回 -32601', async () => {
  const response = await server.request({ jsonrpc: '2.0', id: 11, method: 'nope/method' })
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
  assert.equal(result.stderr, '')
  assert.ok(!result.stdout.includes(TEST_PASSWORD))
  assert.ok(!result.stderr.includes(TEST_PASSWORD))
})
