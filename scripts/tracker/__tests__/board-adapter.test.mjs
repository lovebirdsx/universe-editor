/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  board 适配器测试（真实本地 HTTP 假服务器）。覆盖登录 Cookie、401 重登、状态/标签映射、
 *  claim 语义、eligible 过滤与错误码。运行：node --test。
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

test('listRequirements: 状态 + 标签过滤，映射摘要字段与需求链接', async () => {
  const adapter = makeAdapter()
  const items = await adapter.listRequirements({
    status: ['planned'],
    labels: ['ai-ready'],
  })

  assert.deepEqual(
    items.map((item) => item.id),
    ['p1'],
  )
  assert.deepEqual(items[0], {
    id: 'p1',
    title: 'Add widget',
    url: 'https://tracker.example.com/posts/p1',
    status: 'planned',
    labels: ['ai-ready'],
    priority: 2,
    effort: 3,
    createdAt: '2026-01-02T00:00:00.000Z',
  })

  assert.equal(fake.state.lastByBoardBody.status, 'Planned')
  assert.deepEqual(fake.state.lastByBoardBody.tags, ['tag-ai'])
  assert.equal(fake.state.lastByBoardBody.deleteType, 'notDeleted')
  assert.equal(fake.state.lastByBoardBody.sortBy, 'createdAt')
  assert.equal(fake.state.lastByBoardBody.sortOrder, 'DESC')
})

test('listRequirements: UnderReview 归入 open，多状态合并后按 createdAt 倒序', async () => {
  const adapter = makeAdapter()
  const items = await adapter.listRequirements({
    status: ['open', 'planned'],
    labels: ['ai-ready'],
  })

  assert.deepEqual(
    items.map((item) => [item.id, item.status]),
    [
      ['p4', 'open'],
      ['p1', 'planned'],
    ],
  )
})

test('listRequirements: 标签一个都不认识时直接返回空', async () => {
  const adapter = makeAdapter()
  assert.deepEqual(await adapter.listRequirements({ labels: ['no-such-label'] }), [])
})

test('getRequirement: 正文、附件、评论作者解析与隐藏标记剥离', async () => {
  const adapter = makeAdapter()
  const requirement = await adapter.getRequirement({ id: 'p1' })

  assert.equal(requirement.id, 'p1')
  assert.equal(requirement.body, '## Body\n\nWidget spec')
  assert.deepEqual(requirement.attachments, [{ name: 'spec.md', url: `${fake.url}/files/spec.md` }])
  assert.deepEqual(requirement.comments, [
    { author: 'alice', body: 'first comment', createdAt: '2026-01-02T01:00:00.000Z' },
    { author: 'bob', body: 'claimed', createdAt: '2026-01-02T02:00:00.000Z' },
  ])
})

test('claim: planned → in_progress 并写入隐藏标记；重复认领返回 ok:false', async () => {
  const adapter = makeAdapter()
  const first = await adapter.claim({ id: 'p1', runId: 'run-1' })
  assert.deepEqual(first, { ok: true, claimedBy: 'run-1' })

  const post = fake.state.posts.find((item) => item._id === 'p1')
  assert.equal(post.status, 'InProgress')
  assert.match(fake.state.lastAuthCookie, /^jwt=tok-\d+$/)
  const request = fake.state.commentRequests.at(-1)
  assert.equal(request.op.type, 'changePostStatus')
  assert.match(request.content, /<!-- tracker-claim:run-1 -->/)

  const second = await adapter.claim({ id: 'p1', runId: 'run-2' })
  assert.deepEqual(second, { ok: false, claimedBy: 'run-1' })
})

test('claim: done/closed 直接 ok:false；非法 runId 报 INVALID', async () => {
  const adapter = makeAdapter()
  assert.deepEqual(await adapter.claim({ id: 'p3', runId: 'run-1' }), { ok: false })

  await assert.rejects(
    () => adapter.claim({ id: 'p5', runId: 'has space' }),
    (error) => error instanceof TrackerError && error.code === 'INVALID',
  )
})

test('transition: 状态映射与幂等', async () => {
  const adapter = makeAdapter()
  assert.deepEqual(await adapter.transition({ id: 'p1', to: 'done' }), {
    ok: true,
    from: 'planned',
    to: 'done',
  })
  assert.equal(fake.state.posts.find((item) => item._id === 'p1').status, 'Complete')

  const before = fake.state.commentRequests.length
  assert.deepEqual(await adapter.transition({ id: 'p1', to: 'done' }), {
    ok: true,
    from: 'done',
    to: 'done',
  })
  assert.equal(fake.state.commentRequests.length, before)

  await assert.rejects(
    () => adapter.transition({ id: 'p1', to: 'nope' }),
    (error) => error instanceof TrackerError && error.code === 'INVALID',
  )
})

test('comment: 401 后自动重登一次并重试', async () => {
  const adapter = makeAdapter()
  // 先成功写一次拿到 token，再让下一次鉴权请求模拟 token 过期。
  await adapter.comment({ id: 'p1', body: 'warmup' })
  const loginsBefore = fake.state.logins

  fake.state.rejectNextAuth = true
  const result = await adapter.comment({ id: 'p1', body: 'hello from bot' })

  assert.deepEqual(result, { ok: true })
  assert.equal(fake.state.logins, loginsBefore + 1)
  assert.equal(fake.state.comments.p1.at(-1).content, 'hello from bot')
})

test('错误映射: NOT_FOUND / AUTH / INVALID', async () => {
  const adapter = makeAdapter()
  await assert.rejects(
    () => adapter.getRequirement({ id: 'missing' }),
    (error) => error instanceof TrackerError && error.code === 'NOT_FOUND',
  )

  const noCredentials = makeAdapter({ username: undefined, password: undefined })
  await assert.rejects(
    () => noCredentials.comment({ id: 'p1', body: 'x' }),
    (error) => error instanceof TrackerError && error.code === 'AUTH',
  )

  await assert.rejects(
    () => adapter.comment({ id: 'p1', body: '   ' }),
    (error) => error instanceof TrackerError && error.code === 'INVALID',
  )
})

test('错误映射: 登录失败返回 AUTH 且不泄露密码', async () => {
  const adapter = makeAdapter({ password: 'wrong-password' })
  await assert.rejects(
    () => adapter.comment({ id: 'p1', body: 'x' }),
    (error) => {
      assert.ok(error instanceof TrackerError)
      assert.equal(error.code, 'AUTH')
      assert.ok(!String(error.message).includes('wrong-password'))
      return true
    },
  )
})
