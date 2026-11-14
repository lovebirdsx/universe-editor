/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  board 适配器测试（真实本地 HTTP 假服务器）。覆盖登录 Cookie、401 重登、契约 v1 的
 *  状态/标签/游标映射、claim 的 claimed 语义、幂等写与错误码。运行：node --test。
 *--------------------------------------------------------------------------------------------*/

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createBoardAdapter, TrackerError } from '../adapters/board.mjs'
import { normalizeConfig } from '../config.mjs'
import { resetBoardState, startFakeBoard, TEST_PASSWORD, TEST_USERNAME } from './fake-board.mjs'

let fake

before(async () => {
  fake = await startFakeBoard()
})

after(async () => {
  await fake.close()
})

beforeEach(() => {
  resetBoardState(fake.state)
})

function makeAdapter(overrides = {}) {
  return createBoardAdapter(
    normalizeConfig({
      adapter: 'board',
      baseUrl: fake.url,
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      board: 'universe-editor',
      webUrl: 'https://tracker.example.com',
      eligible: { labels: ['ai-ready'], statuses: ['planned'] },
      ...overrides,
    }),
  )
}

test('getCapabilities: 契约版本、状态、认领语义与项目列表', async () => {
  const capabilities = await makeAdapter().getCapabilities()

  assert.equal(capabilities.contractVersion, 1)
  assert.equal(capabilities.tracker, 'board')
  assert.equal(capabilities.claim, 'best-effort')
  assert.deepEqual(capabilities.statuses, ['open', 'planned', 'in_progress', 'done', 'closed'])
  assert.deepEqual(capabilities.projects, [{ id: 'board-1', name: 'universe-editor' }])
})

test('listRequirements: 状态 + 标签全部包含，映射摘要字段与需求链接', async () => {
  const adapter = makeAdapter()
  const result = await adapter.listRequirements({
    status: ['planned'],
    labels: ['ai-ready'],
  })

  assert.deepEqual(
    result.items.map((item) => item.id),
    ['p1'],
  )
  assert.deepEqual(result.items[0], {
    id: 'p1',
    title: 'Add widget',
    status: 'planned',
    labels: ['ai-ready'],
    project: 'universe-editor',
    priority: 2,
    effort: 3,
    createdAt: '2026-01-02T00:00:00.000Z',
    url: 'https://tracker.example.com/posts/p1',
  })
  assert.equal(result.nextCursor, undefined)

  assert.equal(fake.state.lastByBoardBody.status, 'Planned')
  assert.deepEqual(fake.state.lastByBoardBody.tags, ['tag-ai'])
  assert.equal(fake.state.lastByBoardBody.deleteType, 'notDeleted')
})

test('listRequirements: labels 是全部包含，缺任意一个就返回空', async () => {
  const adapter = makeAdapter()
  const result = await adapter.listRequirements({ labels: ['ai-ready', 'bug'] })
  assert.deepEqual(result, { items: [] })
})

test('listRequirements: UnderReview 归入 open，多状态合并后按 createdAt 倒序', async () => {
  const adapter = makeAdapter()
  const result = await adapter.listRequirements({
    status: ['open', 'planned'],
    labels: ['ai-ready'],
  })

  assert.deepEqual(
    result.items.map((item) => [item.id, item.status]),
    [
      ['p4', 'open'],
      ['p1', 'planned'],
    ],
  )
})

test('listRequirements: limit 与不透明游标分页', async () => {
  const adapter = makeAdapter()
  const first = await adapter.listRequirements({ labels: ['ai-ready'], limit: 1 })
  assert.deepEqual(
    first.items.map((item) => item.id),
    ['p4'],
  )
  assert.equal(typeof first.nextCursor, 'string')

  const second = await adapter.listRequirements({
    labels: ['ai-ready'],
    limit: 1,
    cursor: first.nextCursor,
  })
  assert.deepEqual(
    second.items.map((item) => item.id),
    ['p1'],
  )

  await assert.rejects(
    () => adapter.listRequirements({ cursor: 'not a cursor!' }),
    (error) => error instanceof TrackerError && error.code === 'INVALID',
  )
})

test('listRequirements: since 过滤 createdAt 早于时间的需求', async () => {
  const adapter = makeAdapter()
  const result = await adapter.listRequirements({
    status: ['open', 'planned'],
    labels: ['ai-ready'],
    since: '2026-01-03T00:00:00.000Z',
  })
  assert.deepEqual(
    result.items.map((item) => item.id),
    ['p4'],
  )

  await assert.rejects(
    () => adapter.listRequirements({ since: 'yesterday' }),
    (error) => error instanceof TrackerError && error.code === 'INVALID',
  )
})

test('getRequirement: 正文、作者/负责人、附件与隐藏标记剥离', async () => {
  const adapter = makeAdapter()
  const requirement = await adapter.getRequirement({ id: 'p1' })

  assert.equal(requirement.id, 'p1')
  assert.equal(requirement.body, '## Body\n\nWidget spec')
  assert.deepEqual(requirement.author, { id: 'u1', name: 'alice' })
  assert.deepEqual(requirement.assignees, [{ id: 'u2', name: 'bob', role: 'owner' }])
  assert.deepEqual(requirement.attachments, [{ name: 'spec.md', url: `${fake.url}/files/spec.md` }])
  assert.deepEqual(requirement.comments, [
    {
      id: 'c1',
      author: { id: 'u1', name: 'alice' },
      body: 'first comment',
      createdAt: '2026-01-02T01:00:00.000Z',
    },
    {
      id: 'c2',
      author: { id: 'u2', name: 'bob' },
      body: 'claimed',
      createdAt: '2026-01-02T02:00:00.000Z',
    },
  ])
})

test('claimRequirement: planned → in_progress；同 runId 幂等，其它 runId claimed:false', async () => {
  const adapter = makeAdapter()
  const first = await adapter.claimRequirement({
    id: 'p5',
    runId: 'run-1',
    idempotencyKey: 'run-1:claim',
  })
  assert.deepEqual(first, { claimed: true, claimedBy: 'run-1', status: 'in_progress' })

  const post = fake.state.posts.find((item) => item._id === 'p5')
  assert.equal(post.status, 'InProgress')
  assert.match(fake.state.lastAuthCookie, /^jwt=tok-\d+$/)
  const request = fake.state.commentRequests.at(-1)
  assert.equal(request.op.type, 'changePostStatus')
  assert.match(request.content, /<!-- tracker-claim:run-1 -->/)
  assert.match(request.content, /<!-- tracker-idem:run-1:claim -->/)

  const sameRun = await adapter.claimRequirement({
    id: 'p5',
    runId: 'run-1',
    idempotencyKey: 'run-1:claim',
  })
  assert.deepEqual(sameRun, { claimed: true, claimedBy: 'run-1', status: 'in_progress' })

  const otherRun = await adapter.claimRequirement({
    id: 'p5',
    runId: 'run-2',
    idempotencyKey: 'run-2:claim',
  })
  assert.deepEqual(otherRun, { claimed: false, claimedBy: 'run-1', status: 'in_progress' })
})

test('claimRequirement: done/closed 返回 CONFLICT；非法 runId 报 INVALID', async () => {
  const adapter = makeAdapter()
  await assert.rejects(
    () => adapter.claimRequirement({ id: 'p3', runId: 'run-1', idempotencyKey: 'run-1:claim' }),
    (error) => error instanceof TrackerError && error.code === 'CONFLICT',
  )

  await assert.rejects(
    () => adapter.claimRequirement({ id: 'p5', runId: 'has space', idempotencyKey: 'run-1:claim' }),
    (error) => error instanceof TrackerError && error.code === 'INVALID',
  )
})

test('commentRequirement: idempotencyKey 去重', async () => {
  const adapter = makeAdapter()
  const first = await adapter.commentRequirement({
    id: 'p1',
    body: '开始处理',
    idempotencyKey: 'run-1:claim-ack',
  })
  assert.equal(first.duplicate, false)
  assert.match(first.commentId, /^c-new-/)

  const second = await adapter.commentRequirement({
    id: 'p1',
    body: '开始处理',
    idempotencyKey: 'run-1:claim-ack',
  })
  assert.deepEqual(second, { commentId: first.commentId, duplicate: true })
  assert.equal(fake.state.commentRequests.length, 1)
})

test('transitionRequirement: 状态映射、changed 与幂等', async () => {
  const adapter = makeAdapter()
  assert.deepEqual(
    await adapter.transitionRequirement({
      id: 'p1',
      to: 'done',
      idempotencyKey: 'run-1:done',
    }),
    { from: 'planned', to: 'done', changed: true },
  )
  assert.equal(fake.state.posts.find((item) => item._id === 'p1').status, 'Complete')

  const before = fake.state.commentRequests.length
  assert.deepEqual(
    await adapter.transitionRequirement({ id: 'p1', to: 'done', idempotencyKey: 'run-1:done' }),
    { from: 'done', to: 'done', changed: false },
  )
  assert.equal(fake.state.commentRequests.length, before)

  // 已写入的幂等键在状态再次变化后也不会重复写入。
  fake.state.posts.find((item) => item._id === 'p1').status = 'Planned'
  assert.deepEqual(
    await adapter.transitionRequirement({
      id: 'p1',
      to: 'in_progress',
      idempotencyKey: 'run-1:done',
    }),
    { from: 'planned', to: 'in_progress', changed: false },
  )
  assert.equal(fake.state.commentRequests.length, before)

  await assert.rejects(
    () => adapter.transitionRequirement({ id: 'p1', to: 'nope', idempotencyKey: 'run-1:x' }),
    (error) => error instanceof TrackerError && error.code === 'INVALID',
  )
})

test('commentRequirement: 401 后自动重登一次并重试', async () => {
  const adapter = makeAdapter()
  // 先成功写一次拿到 token，再让下一次鉴权请求模拟 token 过期。
  await adapter.commentRequirement({ id: 'p1', body: 'warmup', idempotencyKey: 'run-1:warmup' })
  const loginsBefore = fake.state.logins

  fake.state.rejectNextAuth = true
  const result = await adapter.commentRequirement({
    id: 'p1',
    body: 'hello from bot',
    idempotencyKey: 'run-1:result',
  })

  assert.equal(result.duplicate, false)
  assert.equal(fake.state.logins, loginsBefore + 1)
  assert.match(fake.state.comments.p1.at(-1).content, /^hello from bot/)
})

test('错误映射: NOT_FOUND / AUTH / FORBIDDEN / INVALID', async () => {
  const adapter = makeAdapter()
  await assert.rejects(
    () => adapter.getRequirement({ id: 'missing' }),
    (error) => error instanceof TrackerError && error.code === 'NOT_FOUND',
  )

  const noCredentials = makeAdapter({ username: undefined, password: undefined })
  await assert.rejects(
    () => noCredentials.commentRequirement({ id: 'p1', body: 'x', idempotencyKey: 'run-1:x' }),
    (error) => error instanceof TrackerError && error.code === 'AUTH',
  )

  await assert.rejects(
    () => adapter.commentRequirement({ id: 'p1', body: 'x', idempotencyKey: 'bad key' }),
    (error) => error instanceof TrackerError && error.code === 'INVALID',
  )
})

test('错误映射: 登录失败返回 AUTH 且不泄露密码', async () => {
  const adapter = makeAdapter({ password: 'wrong-password' })
  await assert.rejects(
    () => adapter.commentRequirement({ id: 'p1', body: 'x', idempotencyKey: 'run-1:x' }),
    (error) => {
      assert.ok(error instanceof TrackerError)
      assert.equal(error.code, 'AUTH')
      assert.ok(!String(error.message).includes('wrong-password'))
      return true
    },
  )
})
