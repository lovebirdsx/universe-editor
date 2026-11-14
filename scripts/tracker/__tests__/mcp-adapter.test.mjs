/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  mcp 适配器测试（本地 node:http 假 Streamable HTTP MCP 服务器）。覆盖 JSON / SSE 两种
 *  响应、请求头、token 覆盖、401/403/429 与工具错误映射，以及 `list` / `serve` 桥接。
 *--------------------------------------------------------------------------------------------*/

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMcpAdapter } from '../adapters/mcp.mjs'
import { normalizeConfig } from '../config.mjs'
import { mkTempDir, removeDirWithRetry } from '../../lib/temp-root.mjs'
import { startFakeMcp } from './fake-mcp.mjs'

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'tracker-mcp.mjs')

let fake
let tempDir

before(async () => {
  fake = await startFakeMcp({ token: 'read-token' })
  tempDir = mkTempDir('tracker-mcp-adapter-')
})

after(async () => {
  await fake.close()
  removeDirWithRetry(tempDir)
})

beforeEach(() => {
  fake.reset()
})

function makeAdapter(raw = {}, env = {}) {
  return createMcpAdapter(
    normalizeConfig(
      {
        adapter: 'mcp',
        url: fake.url,
        token: 'read-token',
        project: 'universe-editor',
        eligible: { labels: ['ai-ready'], statuses: ['planned'] },
        ...raw,
      },
      { env },
    ),
    { env },
  )
}

function writeConfig(overrides = {}) {
  const path = join(tempDir, `tracker-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(
    path,
    JSON.stringify({
      adapter: 'mcp',
      url: fake.url,
      token: 'read-token',
      project: 'universe-editor',
      eligible: { labels: ['ai-ready'], statuses: ['planned'] },
      ...overrides,
    }),
  )
  return path
}

function spawnWithConfig(args, configPath, env = {}) {
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, UE_TRACKER_CONFIG: configPath, ...env },
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  return child
}

function runList(configPath, env = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnWithConfig(['list'], configPath, env)
    let stdout = ''
    let stderr = ''
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

test('JSON 响应：initialize → tools/call，请求头符合原生 MCP 契约', async () => {
  const adapter = makeAdapter()
  const capabilities = await adapter.getCapabilities()
  assert.equal(capabilities.contractVersion, 1)
  assert.equal(capabilities.tracker, 'fake-mcp')

  const result = await adapter.listRequirements({
    project: 'universe-editor',
    status: ['planned'],
    labels: ['ai-ready'],
  })
  assert.deepEqual(
    result.items.map((item) => item.id),
    ['r1', 'r2'],
  )

  const initialize = fake.state.requests.find((item) => item.message.method === 'initialize')
  const call = fake.state.requests.find(
    (item) =>
      item.message.method === 'tools/call' && item.message.params?.name === 'list_requirements',
  )
  assert.equal(initialize.headers.authorization, 'Bearer read-token')
  assert.equal(call.headers.authorization, 'Bearer read-token')
  assert.match(String(call.headers.accept), /application\/json/)
  assert.match(String(call.headers.accept), /text\/event-stream/)
  assert.equal(call.headers['mcp-protocol-version'], '2025-06-18')
  assert.equal(call.message.params.name, 'list_requirements')
  assert.deepEqual(call.message.params.arguments, {
    project: 'universe-editor',
    status: ['planned'],
    labels: ['ai-ready'],
  })
})

test('SSE 响应：application/json 与 text/event-stream 都兼容', async () => {
  fake.state.responseMode = 'sse'
  const adapter = makeAdapter()

  const result = await adapter.listRequirements({ status: ['planned'], limit: 1 })
  assert.deepEqual(
    result.items.map((item) => item.id),
    ['r1', 'r2'].slice(0, 1),
  )
  assert.equal(typeof result.nextCursor, 'string')

  const second = await adapter.listRequirements({
    status: ['planned'],
    limit: 1,
    cursor: result.nextCursor,
  })
  assert.deepEqual(
    second.items.map((item) => item.id),
    ['r2'],
  )
})

test('token 可由 UE_TRACKER_TOKEN 覆盖配置里的值', async () => {
  const adapter = makeAdapter({ token: 'wrong-token' }, { UE_TRACKER_TOKEN: 'read-token' })
  const result = await adapter.listRequirements({ status: ['planned'] })
  assert.equal(result.items.length, 2)
})

test('401 映射为 AUTH，且错误信息不泄露 token', async () => {
  const adapter = makeAdapter({ token: 'wrong-token' }, {})
  await assert.rejects(
    () => adapter.listRequirements({ status: ['planned'] }),
    (error) => {
      assert.equal(error.code, 'AUTH')
      assert.ok(!String(error.message).includes('wrong-token'))
      return true
    },
  )
})

test('工具错误映射：NOT_FOUND / INVALID；HTTP 403/429 映射', async () => {
  const adapter = makeAdapter()
  await adapter.getCapabilities()

  await assert.rejects(
    () => adapter.getRequirement({ id: 'missing' }),
    (error) => error.code === 'NOT_FOUND',
  )
  await assert.rejects(
    () =>
      adapter.transitionRequirement({
        id: 'r1',
        to: 'in_progress',
        idempotencyKey: 'bad key',
      }),
    (error) => error.code === 'INVALID',
  )

  fake.state.failNextStatus = 403
  await assert.rejects(
    () => adapter.listRequirements({ status: ['planned'] }),
    (error) => error.code === 'FORBIDDEN',
  )

  fake.state.failNextStatus = 429
  await assert.rejects(
    () => adapter.listRequirements({ status: ['planned'] }),
    (error) => error.code === 'RATE_LIMITED',
  )
})

test('写工具透传：claimed / duplicate / changed', async () => {
  const adapter = makeAdapter()

  assert.deepEqual(
    await adapter.claimRequirement({
      id: 'r1',
      runId: 'run-1',
      idempotencyKey: 'run-1:claim',
    }),
    { claimed: true, claimedBy: 'run-1', status: 'in_progress' },
  )
  assert.deepEqual(
    await adapter.claimRequirement({
      id: 'r1',
      runId: 'run-1',
      idempotencyKey: 'run-1:claim',
    }),
    { claimed: true, claimedBy: 'run-1', status: 'in_progress' },
  )
  assert.deepEqual(
    await adapter.claimRequirement({
      id: 'r1',
      runId: 'run-2',
      idempotencyKey: 'run-2:claim',
    }),
    { claimed: false, claimedBy: 'run-1', status: 'in_progress' },
  )
  await assert.rejects(
    () => adapter.claimRequirement({ id: 'r3', runId: 'run-1', idempotencyKey: 'run-1:claim' }),
    (error) => error.code === 'CONFLICT',
  )

  const comment = await adapter.commentRequirement({
    id: 'r1',
    body: '开始处理',
    idempotencyKey: 'run-1:claim-ack',
  })
  assert.equal(comment.duplicate, false)
  assert.deepEqual(
    await adapter.commentRequirement({
      id: 'r1',
      body: '开始处理',
      idempotencyKey: 'run-1:claim-ack',
    }),
    { commentId: comment.commentId, duplicate: true },
  )

  assert.deepEqual(
    await adapter.transitionRequirement({
      id: 'r1',
      to: 'planned',
      idempotencyKey: 'run-1:to-planned',
    }),
    { from: 'in_progress', to: 'planned', changed: true },
  )
  assert.deepEqual(
    await adapter.transitionRequirement({
      id: 'r1',
      to: 'planned',
      idempotencyKey: 'run-1:to-planned',
    }),
    { from: 'planned', to: 'planned', changed: false },
  )
})

test('list 子命令：mcp 适配器按 project + eligible 取数并输出数组', async () => {
  const configPath = writeConfig()
  const result = await runList(configPath)

  assert.equal(result.status, 0, result.stderr)
  const items = JSON.parse(result.stdout)
  assert.deepEqual(
    items.map((item) => item.id),
    ['r1', 'r2'],
  )
  assert.ok(items.every((item) => item.status === 'planned'))
  assert.ok(!result.stdout.includes('read-token'))
  assert.ok(!result.stderr.includes('read-token'))

  const call = fake.state.requests.find((item) => item.message.method === 'tools/call')
  assert.deepEqual(call.message.params.arguments, {
    project: 'universe-editor',
    status: ['planned'],
    labels: ['ai-ready'],
  })
})

test('serve：stdio server 作为远程 HTTP MCP 的透明桥', async () => {
  const configPath = writeConfig()
  const child = spawnWithConfig(['serve'], configPath)

  const waiters = new Map()
  let buffer = ''
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
        waiter(message)
      }
    }
  })
  const request = (message) =>
    new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('MCP 响应超时')), 5000)
      waiters.set(message.id, (response) => {
        clearTimeout(timer)
        resolvePromise(response)
      })
      child.stdin.write(`${JSON.stringify(message)}\n`)
    })

  try {
    const initialized = await request({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
    })
    assert.equal(initialized.result.serverInfo.name, 'tracker')

    const tools = await request({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    assert.deepEqual(tools.result.tools.map((tool) => tool.name).sort(), [
      'claim_requirement',
      'comment_requirement',
      'get_requirement',
      'get_tracker_capabilities',
      'list_requirements',
      'transition_requirement',
    ])

    const capabilities = await request({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_tracker_capabilities' },
    })
    assert.equal(capabilities.result.structuredContent.contractVersion, 1)
    assert.equal(capabilities.result.structuredContent.tracker, 'fake-mcp')

    const listed = await request({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'list_requirements' },
    })
    assert.deepEqual(
      listed.result.structuredContent.items.map((item) => item.id),
      ['r1', 'r2'],
    )
  } finally {
    child.stdin.end()
    await new Promise((resolvePromise) => {
      child.once('exit', resolvePromise)
      setTimeout(() => child.kill(), 2000)
    })
  }
})
