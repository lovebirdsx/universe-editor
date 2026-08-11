/*---------------------------------------------------------------------------------------------
 *  审批管理 API + 管理页测试（node --test）。真起 server 子进程覆盖：
 *  未配管理令牌 → 管理页/管理 API 503（fail-closed）；错误令牌 401 不区分原因；
 *  注册后列表可见 pending → approve 后 publish 放行；reject 后 token 一律 401；
 *  remove 释放名字（可重新注册）；非 pending 的 approve/reject 409；名下有扩展 remove 409；
 *  管理页 HTML 200。
 *
 *  主实例 register 调用总数 ≤ 默认节流上限 10（本文件共 5 次）。
 *--------------------------------------------------------------------------------------------*/

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bearer,
  demoManifest,
  httpRequest,
  makeAdminToken,
  makeSigningKey,
  makeTestVsix,
  postVsix,
  serverScript,
  spawnServer,
} from './publish-fixture.mjs'

const PORT = 39240
const NOADMIN_PORT = 39241

let root
let galleryRoot
let authDir
let admin
let child
let noAdminChild

function postAdmin(port, action, token, name) {
  return httpRequest(port, `/gallery/api/admin/publishers/${action}`, {
    method: 'POST',
    headers: { ...bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

function listPublishers(port, token) {
  return httpRequest(port, '/gallery/api/admin/publishers', { headers: bearer(token) })
}

async function registerPublisher(port, publisher, extra = {}) {
  const r = await httpRequest(port, '/gallery/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publisher, ...extra }),
  })
  assert.equal(r.status, 201, `register ${publisher} 应 201: ${r.body}`)
  return JSON.parse(r.body)
}

async function adminListNames(port, token) {
  const r = await listPublishers(port, token)
  assert.equal(r.status, 200)
  return JSON.parse(r.body).publishers
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'ue-admin-api-'))
  galleryRoot = join(root, 'gallery')
  // authDir 必须在静态根之外（启动自检红线），放 root 的兄弟目录（随 mkdtemp 随机后缀唯一）
  authDir = `${root}-auth`
  await mkdir(galleryRoot, { recursive: true })
  await writeFile(join(galleryRoot, 'registry.json'), JSON.stringify({ extensions: [] }))
  admin = await makeAdminToken(root)
  const signing = await makeSigningKey(root)
  ;({ child } = await spawnServer({
    root,
    port: PORT,
    extraArgs: [
      '--gallery-root',
      galleryRoot,
      '--auth-dir',
      authDir,
      ...signing.args,
      ...admin.args,
    ],
  }))
  // 对照实例：未配置管理令牌 → 管理面整体 503
  const bareRoot = await mkdtemp(join(tmpdir(), 'ue-admin-off-'))
  ;({ child: noAdminChild } = await spawnServer({
    root: bareRoot,
    port: NOADMIN_PORT,
    extraArgs: ['--gallery-root', join(bareRoot, 'gallery'), '--auth-dir', `${bareRoot}-auth`],
  }))
})

after(() => {
  if (child) child.kill()
  if (noAdminChild) noAdminChild.kill()
})

test('未配置管理令牌: 管理页与管理 API 一律 503', async () => {
  const page = await httpRequest(NOADMIN_PORT, '/gallery/admin')
  assert.equal(page.status, 503)
  const api = await listPublishers(NOADMIN_PORT, 'anything')
  assert.equal(api.status, 503)
  assert.match(api.body, /admin-token-file/)
  const approve = await postAdmin(NOADMIN_PORT, 'approve', 'anything', 'acme')
  assert.equal(approve.status, 503)
})

test('管理 API 认证: 无令牌 / 错误令牌一律 401，不区分原因', async () => {
  const noAuth = await listPublishers(PORT, '')
  const wrong = await listPublishers(PORT, 'wrong-token')
  assert.equal(noAuth.status, 401)
  assert.equal(wrong.status, 401)
  assert.equal(noAuth.body, wrong.body)
})

test('管理页: GET gallery/admin 200，text/html，含令牌输入框标记', async () => {
  const r = await httpRequest(PORT, '/gallery/admin')
  assert.equal(r.status, 200)
  assert.match(r.headers['content-type'], /text\/html/)
  assert.match(r.headers['cache-control'], /no-cache/)
  assert.ok(r.body.includes('审批管理'), '含中文标题')
  assert.ok(r.body.includes('id="token-input"'), '含令牌输入框')
  assert.ok(r.body.includes('./api/admin/'), 'API 走相对路径')
})

test('列表: 注册后可见 pending 条目（含 email/created/扩展计数）', async () => {
  await registerPublisher(PORT, 'acme', { email: 'a@b.c' })
  const publishers = await adminListNames(PORT, admin.token)
  const acme = publishers.find((p) => p.name === 'acme')
  assert.ok(acme, '列表含新注册 publisher')
  assert.equal(acme.status, 'pending')
  assert.equal(acme.email, 'a@b.c')
  assert.ok(!Number.isNaN(Date.parse(acme.created)), 'created 为 ISO 时间戳')
  assert.equal(acme.tokenCount, 1)
  assert.deepEqual(acme.extensions, [])
})

test('approve: pending → active 后 publish 放行（201）', async () => {
  const r = await postAdmin(PORT, 'approve', admin.token, 'acme')
  assert.equal(r.status, 200)
  assert.deepEqual(JSON.parse(r.body), { publisher: 'acme', status: 'active' })

  const publishers = await adminListNames(PORT, admin.token)
  assert.equal(publishers.find((p) => p.name === 'acme').status, 'active')

  // 完整链路：另注册一个 publisher 走 注册（pending 403）→ approve → publish 201
  const bob = await registerPublisher(PORT, 'bob')
  const gated = await postVsix(
    PORT,
    '/gallery/api/publish',
    bob.token,
    makeTestVsix(join(root, 'bob.vsix'), demoManifest({ publisher: 'bob', name: 'demo' })),
  )
  assert.equal(gated.status, 403, 'approve 前 publish 403')
  assert.match(gated.body, /pending approval/)

  const approve = await postAdmin(PORT, 'approve', admin.token, 'bob')
  assert.equal(approve.status, 200)
  const ok = await postVsix(
    PORT,
    '/gallery/api/publish',
    bob.token,
    makeTestVsix(join(root, 'bob.vsix'), demoManifest({ publisher: 'bob', name: 'demo' })),
  )
  assert.equal(ok.status, 201, 'approve 后 publish 放行')

  // 列表里 bob 名下出现该扩展
  const after = await adminListNames(PORT, admin.token)
  assert.deepEqual(after.find((p) => p.name === 'bob').extensions, ['bob.demo'])
})

test('approve/reject: 非 pending 一律 409；未知 publisher 404', async () => {
  const again = await postAdmin(PORT, 'approve', admin.token, 'acme')
  assert.equal(again.status, 409, 'active 不能再 approve')
  const rejectActive = await postAdmin(PORT, 'reject', admin.token, 'acme')
  assert.equal(rejectActive.status, 409, 'active 不能 reject')
  const missing = await postAdmin(PORT, 'approve', admin.token, 'no-such-publisher')
  assert.equal(missing.status, 404)
})

test('reject: pending → rejected 后 token 一律 401（whoami/publish 与无效 token 不可区分）', async () => {
  const carol = await registerPublisher(PORT, 'carol')
  const whoBefore = await httpRequest(PORT, '/gallery/api/whoami', {
    headers: bearer(carol.token),
  })
  assert.equal(whoBefore.status, 200, 'pending 时 whoami 放行')

  const r = await postAdmin(PORT, 'reject', admin.token, 'carol')
  assert.equal(r.status, 200)
  assert.deepEqual(JSON.parse(r.body), { publisher: 'carol', status: 'rejected' })

  const whoAfter = await httpRequest(PORT, '/gallery/api/whoami', {
    headers: bearer(carol.token),
  })
  assert.equal(whoAfter.status, 401)
  assert.equal(whoAfter.body, 'unauthorized', 'rejected 与无效 token 同响应体')
  const pub = await postVsix(
    PORT,
    '/gallery/api/publish',
    carol.token,
    makeTestVsix(join(root, 'carol.vsix'), demoManifest({ publisher: 'carol', name: 'demo' })),
  )
  assert.equal(pub.status, 401)

  const again = await postAdmin(PORT, 'reject', admin.token, 'carol')
  assert.equal(again.status, 409, 'rejected 不能再 reject')
})

test('remove: rejected 且名下无扩展可删，名字立即可重新注册', async () => {
  const r = await postAdmin(PORT, 'remove', admin.token, 'carol')
  assert.equal(r.status, 200)
  assert.deepEqual(JSON.parse(r.body), { removed: 'carol' })

  const publishers = await adminListNames(PORT, admin.token)
  assert.ok(!publishers.some((p) => p.name === 'carol'), '记录已删除')

  const again = await registerPublisher(PORT, 'carol')
  assert.match(again.token, /^uet_/, '名字释放后可重新注册')
})

test('启动自检: --admin-token-file 不存在 / 内容为空 → 拒绝启动', async () => {
  for (const [label, tokenFile] of [
    ['不存在', join(root, 'no-such-admin-token.txt')],
    ['空内容', join(root, 'empty-admin-token.txt')],
  ]) {
    if (label === '空内容') await writeFile(tokenFile, '  \n')
    const bad = spawn(process.execPath, [
      serverScript,
      '--root',
      root,
      '--port',
      '39242',
      '--base',
      '/',
      '--admin-token-file',
      tokenFile,
    ])
    let output = ''
    bad.stdout.on('data', (c) => (output += c))
    bad.stderr.on('data', (c) => (output += c))
    const code = await new Promise((r) => bad.on('exit', r))
    assert.notEqual(code, 0, `${label} 的管理令牌文件必须拒绝启动`)
    assert.match(output, /--admin-token-file/)
  }
})

test('remove: active 或名下有扩展的 publisher 一律 409', async () => {
  const active = await postAdmin(PORT, 'remove', admin.token, 'acme')
  assert.equal(active.status, 409, 'active 不可删')

  // pending 无法 publish，「pending/rejected 名下却有扩展」只会来自运维 scp 直改 registry
  // 的并行写通道——直接改 registry.json 模拟该场景
  const dave = await registerPublisher(PORT, 'dave')
  assert.ok(dave.token)
  const registryFile = join(galleryRoot, 'registry.json')
  await writeFile(
    registryFile,
    JSON.stringify({ extensions: [{ publisher: 'dave', name: 'demo', versions: [] }] }),
  )
  const withExt = await postAdmin(PORT, 'remove', admin.token, 'dave')
  assert.equal(withExt.status, 409, '名下有扩展不可删')
  assert.match(withExt.body, /extensions/)
})
