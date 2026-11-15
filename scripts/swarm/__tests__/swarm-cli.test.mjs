import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { mkTempDir, removeDirWithRetry } from '../../lib/temp-root.mjs'

import {
  buildBasicAuth,
  canApprove,
  latestReviewVersion,
  main,
  parseArgs,
  pickTicketForUser,
} from '../../../docs/user/zh-CN/ai-agent/trigger-templates/swarm-triage/scripts/swarm.mjs'

const TICKET = 'TICKET-SECRET-abc123'
const SWARM_URL = 'https://swarm.example.com'

function capture() {
  let text = ''
  return {
    write(chunk) {
      text += String(chunk)
    },
    get text() {
      return text
    },
  }
}

function fakeP4({
  info = '... userName testuser',
  loginStatus = 0,
  tickets = `p4.example.com (testuser) ${TICKET}`,
} = {}) {
  const calls = []
  const runP4 = (args) => {
    calls.push(args.join(' '))
    switch (args.join(' ')) {
      case '-ztag info':
        return { status: 0, stdout: `${info}\n`, stderr: '' }
      case 'login -s':
        return { status: loginStatus, stdout: '', stderr: '' }
      case 'tickets':
        return { status: 0, stdout: `${tickets}\n`, stderr: '' }
      default:
        return { status: 127, stdout: '', stderr: 'unknown command' }
    }
  }
  return { runP4, calls }
}

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (payload === undefined ? '' : JSON.stringify(payload)),
  }
}

function fakeFetch(handler) {
  const calls = []
  const fetch = async (url, init) => {
    const call = { url, init }
    calls.push(call)
    return handler(call)
  }
  return { fetch, calls }
}

function deps({ fetch, runP4 = fakeP4().runP4, env = {}, readFile } = {}) {
  return {
    fetch,
    runP4,
    env,
    stdout: capture(),
    stderr: capture(),
    ...(readFile === undefined ? {} : { readFile }),
  }
}

function jsonOf(stdout) {
  return JSON.parse(stdout.text)
}

test('parseArgs: get 的基本形态与默认值', () => {
  const options = parseArgs(['get', '100801'])
  assert.equal(options.command, 'get')
  assert.equal(options.reviewId, '100801')
  assert.equal(options.apiVersion, 'v9')
})

test('parseArgs: 未知子命令 / 缺 reviewId / 非法投票方向都是用法错误', () => {
  assert.throws(() => parseArgs(['nope', '1']), /未知子命令/)
  assert.throws(() => parseArgs(['get']), /需要 <reviewId>/)
  assert.throws(() => parseArgs(['vote', '1', 'sideways']), /up 或 down/)
  assert.throws(() => parseArgs(['comment', '1']), /--body/)
  assert.throws(() => parseArgs(['comment', '1', '--body', 'x', '--body-file', 'y']), /只能给一个/)
  assert.throws(() => parseArgs(['get', '1', '--unknown']), /未知参数/)
  assert.throws(() => parseArgs(['get', '1', '--url']), /--url 需要值/)
  assert.equal(parseArgs(['--help']).help, true)
})

test('pickTicketForUser 大小写不敏感且后出现的优先', () => {
  const stdout = ['p4.example.com (TestUser) first', 'p4.example.com (testuser) second'].join('\n')
  assert.equal(pickTicketForUser(stdout, 'TESTUSER'), 'second')
  assert.equal(pickTicketForUser('p4.example.com (other) nope', 'testuser'), undefined)
})

test('latestReviewVersion 兼容 rev / difference / version，取最后一个', () => {
  assert.equal(latestReviewVersion({ versions: [{ rev: 1 }, { difference: 4 }] }), 4)
  assert.equal(latestReviewVersion({ versions: [{ version: 2 }, { version: 7 }] }), 7)
  assert.equal(latestReviewVersion({ versions: [] }), undefined)
})

test('canApprove 只认精确的 approved（approved:commit 不算）', () => {
  assert.equal(canApprove({ transitions: { approved: 'Approve' } }), true)
  assert.equal(canApprove({ transitions: ['approved'] }), true)
  assert.equal(canApprove({ transitions: { 'approved:commit': 'Approve & Commit' } }), false)
  assert.equal(canApprove({ transitions: { needsReview: 'Needs Review' } }), false)
})

test('get：用 p4 ticket 构造 Basic 头并输出单行摘要', async () => {
  const { fetch, calls } = fakeFetch((call) => {
    if (call.init.method === 'GET' && call.url.endsWith('/reviews/100801')) {
      return response(200, {
        review: {
          id: '100801',
          state: 'needsReview',
          author: 'ann',
          description: 'fix typo',
          versions: [{ rev: 1 }, { rev: 3 }],
        },
      })
    }
    if (call.init.method === 'GET' && call.url.endsWith('/reviews/100801/transitions')) {
      return response(200, { transitions: { needsReview: 'Needs Review', approved: 'Approve' } })
    }
    return response(500, {})
  })
  const d = deps({ fetch })

  const code = await main(['get', '100801', '--url', SWARM_URL], d)

  assert.equal(code, 0)
  assert.equal(calls[0].url, `${SWARM_URL}/api/v9/reviews/100801`)
  assert.equal(calls[0].init.headers.Authorization, buildBasicAuth('testuser', TICKET))
  assert.deepEqual(jsonOf(d.stdout), {
    id: '100801',
    state: 'needsReview',
    author: 'ann',
    description: 'fix typo',
    versionCount: 2,
    latestVersion: 3,
    transitions: ['needsReview', 'approved'],
  })
  assert.equal(d.stderr.text, '')
  assert.ok(!d.stdout.text.includes(TICKET))
})

test('vote：先读审核详情，用最新版本号投票', async () => {
  const { fetch, calls } = fakeFetch((call) => {
    if (call.init.method === 'GET') {
      return response(200, { review: { id: '100801', versions: [{ rev: 1 }, { rev: 5 }] } })
    }
    return response(200, {})
  })
  const d = deps({ fetch })

  const code = await main(['vote', '100801', 'up', '--url', SWARM_URL], d)

  assert.equal(code, 0)
  const post = calls.find((call) => call.init.method === 'POST')
  assert.equal(post.url, `${SWARM_URL}/api/v9/reviews/100801/vote`)
  assert.deepEqual(JSON.parse(post.init.body), { vote: 'up', version: 5 })
  assert.deepEqual(jsonOf(d.stdout), {
    ok: true,
    command: 'vote',
    reviewId: '100801',
    vote: 'up',
    version: 5,
  })
})

test('approve：转换不可用时拒绝，且不发 PATCH', async () => {
  const { fetch, calls } = fakeFetch(() =>
    response(200, { transitions: { needsReview: 'Needs Review', rejected: 'Reject' } }),
  )
  const d = deps({ fetch })

  const code = await main(['approve', '100801', '--url', SWARM_URL], d)

  assert.equal(code, 1)
  assert.match(d.stderr.text, /不允许 approved 转换/)
  assert.equal(calls.filter((call) => call.init.method === 'PATCH').length, 0)
  assert.equal(d.stdout.text, '')
})

test('approve：可用时只发送 { state: "approved" }（不带 commit）', async () => {
  const { fetch, calls } = fakeFetch((call) => {
    if (call.init.method === 'PATCH') return response(200, {})
    return response(200, { transitions: { approved: 'Approve' } })
  })
  const d = deps({ fetch })

  const code = await main(['approve', '100801', '--url', SWARM_URL], d)

  assert.equal(code, 0)
  const patch = calls.find((call) => call.init.method === 'PATCH')
  assert.equal(patch.url, `${SWARM_URL}/api/v9/reviews/100801/state`)
  assert.deepEqual(JSON.parse(patch.init.body), { state: 'approved' })
  assert.deepEqual(jsonOf(d.stdout), {
    ok: true,
    command: 'approve',
    reviewId: '100801',
    state: 'approved',
  })
})

test('comment：--body 原样写入 topic 评论；--body-file 从文件读正文', async (t) => {
  const dir = mkTempDir('ue-swarm-cli-')
  t.after(() => removeDirWithRetry(dir))
  const bodyFile = join(dir, 'note.md')
  writeFileSync(bodyFile, '来自文件的评论', 'utf8')

  for (const args of [
    ['comment', '100801', '--body', '已核对', '--url', SWARM_URL],
    ['comment', '100801', '--body-file', bodyFile, '--url', SWARM_URL],
  ]) {
    const { fetch, calls } = fakeFetch(() => response(200, { comment: { id: 'c-1' } }))
    const d = deps({ fetch })

    const code = await main(args, d)

    assert.equal(code, 0)
    const post = calls.find((call) => call.init.method === 'POST')
    assert.equal(post.url, `${SWARM_URL}/api/v9/comments`)
    assert.deepEqual(JSON.parse(post.init.body), {
      topic: 'reviews/100801',
      body: args.includes('--body') ? '已核对' : '来自文件的评论',
    })
    assert.equal(jsonOf(d.stdout).commentId, 'c-1')
  }
})

test('缺少 Swarm 地址时报用法错误，且不执行 p4', async () => {
  const p4 = fakeP4()
  const { fetch } = fakeFetch(() => response(200, {}))
  const d = deps({ fetch, runP4: p4.runP4, env: {} })

  const code = await main(['get', '100801'], d)

  assert.equal(code, 2)
  assert.match(d.stderr.text, /--url/)
  assert.match(d.stderr.text, /UE_SWARM_URL/)
  assert.deepEqual(p4.calls, [])
})

test('UE_SWARM_URL 可作为地址来源', async () => {
  const { fetch, calls } = fakeFetch((call) =>
    call.url.endsWith('/transitions')
      ? response(200, { transitions: { approved: 'Approve' } })
      : response(200, { review: { id: '100801', versions: [] } }),
  )
  const d = deps({ fetch, env: { UE_SWARM_URL: SWARM_URL } })

  const code = await main(['get', '100801'], d)

  assert.equal(code, 0)
  assert.equal(calls[0].url, `${SWARM_URL}/api/v9/reviews/100801`)
})

test('RED LINE：ticket 不出现在 stdout / stderr，HTTP 401 / 500 只报 method + path + status', async () => {
  for (const status of [401, 500]) {
    const { fetch, calls } = fakeFetch(() => response(status, {}))
    const d = deps({ fetch })

    const code = await main(['get', '100801', '--url', SWARM_URL], d)

    assert.equal(code, 1)
    assert.equal(d.stdout.text, '')
    assert.ok(!d.stderr.text.includes(TICKET), `stderr 泄露了 ticket: ${d.stderr.text}`)
    assert.ok(!d.stdout.text.includes(TICKET))
    assert.match(d.stderr.text, new RegExp(`GET reviews/100801 失败：HTTP ${status}`))
    assert.equal(calls.length, 1)
  }
})

test('RED LINE：p4 失败时也不回显 tickets / login 输出', async () => {
  const p4 = fakeP4({ tickets: 'p4.example.com (testuser) TICKET-SECRET-leak' })
  const p4Status = {
    runP4: (args) => {
      const key = args.join(' ')
      if (key === '-ztag info') return p4.runP4(args)
      if (key === 'login -s') return { status: 0, stdout: '', stderr: '' }
      return { status: 1, stdout: '', stderr: `bad ticket TICKET-SECRET-leak` }
    },
  }
  const { fetch } = fakeFetch(() => response(200, {}))
  const d = deps({ fetch, runP4: p4Status.runP4 })

  const code = await main(['get', '100801', '--url', SWARM_URL], d)

  assert.equal(code, 1)
  assert.match(d.stderr.text, /p4 tickets 失败/)
  assert.ok(!d.stderr.text.includes('TICKET-SECRET-leak'))
})

test('RED LINE：p4 超时（spawnSync ETIMEDOUT）报明确原因，不回显 p4 输出', async () => {
  const timeoutError = Object.assign(new Error('spawnSync p4 ETIMEDOUT'), { code: 'ETIMEDOUT' })
  const p4Timeout = {
    runP4: (args) =>
      args.join(' ') === '-ztag info'
        ? {
            status: null,
            signal: 'SIGTERM',
            error: timeoutError,
            stdout: `... userName testuser`,
            stderr: `p4 ticket ${TICKET}`,
          }
        : { status: 0, stdout: '', stderr: '' },
  }
  const { fetch } = fakeFetch(() => response(200, {}))
  const d = deps({ fetch, runP4: p4Timeout.runP4 })

  const code = await main(['get', '100801', '--url', SWARM_URL], d)

  assert.equal(code, 1)
  assert.equal(d.stdout.text, '')
  assert.match(d.stderr.text, /p4 执行超时（15 秒）/)
  assert.ok(!d.stderr.text.includes(TICKET))
})

test('RED LINE：p4 被信号终止（无 error 对象）也会明确报错且不回显输出', async () => {
  const p4Killed = {
    runP4: (args) =>
      args.join(' ') === 'login -s'
        ? { status: null, signal: 'SIGKILL', stdout: TICKET, stderr: TICKET }
        : { status: 0, stdout: '... userName testuser\n', stderr: '' },
  }
  const { fetch } = fakeFetch(() => response(200, {}))
  const d = deps({ fetch, runP4: p4Killed.runP4 })

  const code = await main(['get', '100801', '--url', SWARM_URL], d)

  assert.equal(code, 1)
  assert.match(d.stderr.text, /p4 被信号 SIGKILL 终止/)
  assert.ok(!d.stderr.text.includes(TICKET))
})

test('网络超时：只报 method + path（30 秒），不带地址与 ticket，且请求带 AbortSignal', async () => {
  const { fetch, calls } = fakeFetch(() => {
    const error = new Error('The operation was aborted due to timeout')
    error.name = 'TimeoutError'
    throw error
  })
  const d = deps({ fetch })

  const code = await main(['get', '100801', '--url', SWARM_URL], d)

  assert.equal(code, 1)
  assert.equal(d.stdout.text, '')
  assert.match(d.stderr.text, /GET reviews\/100801 请求超时（30 秒）/)
  assert.ok(!d.stderr.text.includes(SWARM_URL))
  assert.ok(!d.stderr.text.includes(TICKET))
  assert.ok(calls[0].init.signal instanceof AbortSignal)
})
