/*---------------------------------------------------------------------------------------------
 *  publisher 自助注册 API + 注册页测试（node --test）。真起 server 子进程覆盖：
 *  register 201（落库只有哈希无明文 + 紧随 whoami 200＝缓存显式失效生效）/ 审批制 pending
 *  门控（publish/unpublish 403）/ 重名 409 / 非法名·非法 email·非法 JSON 400 / label 默认值 /
 *  IP 节流 429 / 注册页 HTML。
 *
 *  主实例 --register-rate-limit 20：本文件对主实例的 register 调用总数必须 ≤20
 *  （非法 JSON 在节流判定之前 400，不占额度），节流专项用独立实例 --register-rate-limit 2。
 *--------------------------------------------------------------------------------------------*/

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bearer,
  httpRequest,
  makeTokenEntry,
  spawnServer,
  writePublishers,
} from './publish-fixture.mjs'

const PORT = 39230
const RATE_PORT = 39231

let root
let authDir
let child

function postRegister(port, payload, rawBody) {
  return httpRequest(port, '/gallery/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rawBody ?? JSON.stringify(payload),
  })
}

async function readPublishers() {
  return JSON.parse(await readFile(join(authDir, 'publishers.json'), 'utf8'))
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'ue-register-api-'))
  const galleryRoot = join(root, 'gallery')
  // authDir 必须在静态根之外（启动自检红线），放 root 的兄弟目录（随 mkdtemp 随机后缀唯一）
  authDir = `${root}-auth`
  await mkdir(galleryRoot, { recursive: true })
  await writeFile(join(galleryRoot, 'registry.json'), JSON.stringify({ extensions: [] }))
  // 既有 publisher：验证重名 409 不区分来源（运维签发与自助注册同等占用名字）
  await writePublishers(authDir, [
    { name: 'taken', tokens: [makeTokenEntry('uet_testtoken_taken_000000000000000', 'ops')] },
  ])
  ;({ child } = await spawnServer({
    root,
    port: PORT,
    extraArgs: [
      '--gallery-root',
      galleryRoot,
      '--auth-dir',
      authDir,
      '--register-rate-limit',
      '20',
    ],
  }))
})

after(() => {
  if (child) child.kill()
})

test('register: 201，token 只落 sha256 哈希不落明文，email 落库，紧随 whoami 必须 200', async () => {
  const r = await postRegister(PORT, { publisher: 'acme', email: 'a@b.c', label: 'laptop' })
  assert.equal(r.status, 201)
  const body = JSON.parse(r.body)
  assert.equal(body.publisher, 'acme')
  assert.equal(body.label, 'laptop')
  assert.equal(body.status, 'pending', '审批制：注册即 pending')
  assert.match(body.token, /^uet_/)
  assert.ok(!('email' in body), 'email 不回显')

  const raw = await readFile(join(authDir, 'publishers.json'), 'utf8')
  assert.ok(!raw.includes(body.token), 'publishers.json 不含明文 token')
  const data = JSON.parse(raw)
  const entry = data.publishers.find((p) => p.name === 'acme')
  assert.ok(entry, 'publisher 落库')
  assert.equal(entry.email, 'a@b.c')
  assert.equal(entry.status, 'pending', '落库状态为 pending')
  assert.ok(!Number.isNaN(Date.parse(entry.created)), 'created 为 ISO 时间戳')
  assert.equal(entry.tokens.length, 1)
  assert.match(entry.tokens[0].hash, /^[0-9a-f]{64}$/, '只落 sha256 hex')
  assert.equal(entry.tokens[0].label, 'laptop')
  assert.equal(entry.tokens[0].revoked, null)

  // 回归护栏：authenticate 走 mtime 缓存，同秒写入 mtime 可能不变——
  // register 必须显式失效缓存，否则这里 401
  const who = await httpRequest(PORT, '/gallery/api/whoami', { headers: bearer(body.token) })
  assert.equal(who.status, 200, 'pending 也放行 whoami（作者靠它查审批进度）')
  assert.deepEqual(JSON.parse(who.body), { publisher: 'acme', status: 'pending' })
})

test('审批门控: pending 的 publisher publish/unpublish 一律 403（消息含 pending）', async () => {
  const data = await readPublishers()
  const acme = data.publishers.find((p) => p.name === 'acme')
  assert.equal(acme.status, 'pending')
  // 从注册响应拿不到 token 了（上一用例的局部变量），重新注册会 409——
  // 直接从重名 409 可知占名仍在；这里用上一用例落库的哈希反推不可行，
  // 故走独立通道：再注册一个 pending publisher 专门测门控。
  const r = await postRegister(PORT, { publisher: 'gated' })
  assert.equal(r.status, 201)
  const { token } = JSON.parse(r.body)

  const pub = await httpRequest(PORT, '/gallery/api/publish', {
    method: 'POST',
    headers: { ...bearer(token), 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('not even a zip'),
  })
  assert.equal(pub.status, 403)
  assert.match(pub.body, /pending approval/)

  const unpub = await httpRequest(PORT, '/gallery/api/unpublish', {
    method: 'POST',
    headers: { ...bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'gated.demo', version: null }),
  })
  assert.equal(unpub.status, 403)
  assert.match(unpub.body, /pending approval/)
})

test('register: 重名一律 409（自助注册的 acme 与运维签发的 taken 同等处理）', async () => {
  const again = await postRegister(PORT, { publisher: 'acme' })
  assert.equal(again.status, 409)
  assert.match(again.body, /publisher name is taken/)
  const ops = await postRegister(PORT, { publisher: 'taken' })
  assert.equal(ops.status, 409)
  assert.match(ops.body, /publisher name is taken/)
})

test('register: 非法 publisher 名 400（大写 / 前导连字符 / 超 64 长 / 保留名）', async () => {
  const cases = [
    ['Acme', /match/],
    ['-acme', /match/],
    ['a'.repeat(65), /at most 64/],
    ['universe', /reserved/],
  ]
  for (const [publisher, re] of cases) {
    const r = await postRegister(PORT, { publisher })
    assert.equal(r.status, 400, `${publisher} 必须 400`)
    assert.match(r.body, re, `${publisher} 错误消息须指明规则`)
  }
})

test('register: email 非法 400；email 省略 201', async () => {
  const bad = await postRegister(PORT, { publisher: 'badmail', email: 'not-an-email' })
  assert.equal(bad.status, 400)
  assert.match(bad.body, /email/)
  const ok = await postRegister(PORT, { publisher: 'nomail' })
  assert.equal(ok.status, 201)
  const data = await readPublishers()
  assert.ok(!('email' in data.publishers.find((p) => p.name === 'nomail')), 'email 缺省不落字段')
})

test('register: label 省略默认 web-register', async () => {
  const r = await postRegister(PORT, { publisher: 'plain' })
  assert.equal(r.status, 201)
  assert.equal(JSON.parse(r.body).label, 'web-register')
  const data = await readPublishers()
  assert.equal(data.publishers.find((p) => p.name === 'plain').tokens[0].label, 'web-register')
})

test('register: 非法 JSON body 400', async () => {
  const r = await postRegister(PORT, null, 'this is { not json')
  assert.equal(r.status, 400)
  assert.match(r.body, /invalid JSON/)
})

test('register: IP 节流——--register-rate-limit 2 时第 3 次注册 429', async () => {
  const limitedRoot = await mkdtemp(join(tmpdir(), 'ue-register-rl-'))
  const limitedAuth = `${limitedRoot}-auth`
  const limited = await spawnServer({
    root: limitedRoot,
    port: RATE_PORT,
    extraArgs: [
      '--gallery-root',
      join(limitedRoot, 'gallery'),
      '--auth-dir',
      limitedAuth,
      '--register-rate-limit',
      '2',
    ],
  })
  try {
    const r1 = await postRegister(RATE_PORT, { publisher: 'p-one' })
    const r2 = await postRegister(RATE_PORT, { publisher: 'p-two' })
    const r3 = await postRegister(RATE_PORT, { publisher: 'p-three' })
    assert.equal(r1.status, 201)
    assert.equal(r2.status, 201)
    assert.equal(r3.status, 429)
  } finally {
    limited.child.kill()
  }
})

test('注册页: GET gallery/register 200，text/html，含表单标记', async () => {
  const r = await httpRequest(PORT, '/gallery/register')
  assert.equal(r.status, 200)
  assert.match(r.headers['content-type'], /text\/html/)
  assert.match(r.headers['cache-control'], /no-cache/)
  assert.ok(r.body.includes('注册发布者'), '含中文标题')
  assert.ok(r.body.includes('id="publisher"'), '含 publisher 表单字段')
  assert.ok(r.body.includes('./api/register'), '表单提交走相对路径')
})
