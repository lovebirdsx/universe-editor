/*---------------------------------------------------------------------------------------------
 *  publish API 服务端流水线测试（node --test）。真起 server 子进程覆盖：
 *  whoami 401 不区分原因 / publish 各拒绝分支（400/403/409/413）与 happy path（资产落地 +
 *  registry 更新 + extensionquery 立即可见＝缓存显式失效生效）/ unpublish 各分支 /
 *  auth-dir 落入静态根的启动自检。
 *--------------------------------------------------------------------------------------------*/

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, verify } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bearer,
  demoManifest,
  httpRequest,
  makeSigningKey,
  makeTestVsix,
  makeTokenEntry,
  postVsix,
  queryExtension,
  serverScript,
  spawnServer,
  writePublishers,
} from './publish-fixture.mjs'

const PORT = 39220
const TOKEN = 'uet_testtoken_acme_0000000000000000'
const OTHER_TOKEN = 'uet_testtoken_globex_00000000000000'

let root
let galleryRoot
let authDir
let vsixPath
let signing
let child

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'ue-publish-api-'))
  galleryRoot = join(root, 'gallery')
  // authDir 必须在静态根之外（启动自检红线），放 root 的兄弟目录（随 mkdtemp 随机后缀唯一）
  authDir = `${root}-auth`
  await mkdir(galleryRoot, { recursive: true })
  await writeFile(
    join(galleryRoot, 'registry.json'),
    JSON.stringify({
      extensions: [
        {
          publisher: 'acme',
          name: 'taken',
          displayName: 'Taken',
          versions: [
            {
              version: '1.0.0',
              lastUpdated: '2026-01-01T00:00:00Z',
              engine: '^0.1.0',
              assetDir: 'assets/acme.taken/1.0.0',
              files: { vsix: 'acme.taken-1.0.0.vsix' },
            },
          ],
        },
      ],
    }),
  )
  await writePublishers(authDir, [
    { name: 'acme', tokens: [makeTokenEntry(TOKEN, 'laptop')] },
    { name: 'globex', tokens: [makeTokenEntry(OTHER_TOKEN, 'ci')] },
  ])
  vsixPath = join(root, 'fixture.vsix')
  makeTestVsix(vsixPath, demoManifest())
  signing = await makeSigningKey(root)
  ;({ child } = await spawnServer({
    root,
    port: PORT,
    extraArgs: ['--gallery-root', galleryRoot, '--auth-dir', authDir, ...signing.args],
  }))
})

after(() => {
  if (child) child.kill()
})

/*--------------------------------- whoami ---------------------------------*/

test('whoami: 无 token / 假 token 一律 401 不区分原因', async () => {
  const noAuth = await httpRequest(PORT, '/gallery/api/whoami')
  assert.equal(noAuth.status, 401)
  const wrong = await httpRequest(PORT, '/gallery/api/whoami', { headers: bearer('uet_wrong') })
  assert.equal(wrong.status, 401)
  assert.equal(noAuth.body, wrong.body)
})

test('whoami: 正确 token 返回 publisher + status（无 status 字段的历史记录按 active）', async () => {
  const r = await httpRequest(PORT, '/gallery/api/whoami', { headers: bearer(TOKEN) })
  assert.equal(r.status, 200)
  assert.deepEqual(JSON.parse(r.body), { publisher: 'acme', status: 'active' })
})

test('whoami: 已吊销 token 401（通过重启前改写 publishers.json 验证 mtime 重载）', async () => {
  await writePublishers(authDir, [
    {
      name: 'acme',
      tokens: [makeTokenEntry(TOKEN, 'laptop', '2026-08-01T01:00:00Z')],
    },
    { name: 'globex', tokens: [makeTokenEntry(OTHER_TOKEN, 'ci')] },
  ])
  const r = await httpRequest(PORT, '/gallery/api/whoami', { headers: bearer(TOKEN) })
  assert.equal(r.status, 401)
  // 恢复有效 token，后续用例继续用
  await writePublishers(authDir, [
    { name: 'acme', tokens: [makeTokenEntry(TOKEN, 'laptop')] },
    { name: 'globex', tokens: [makeTokenEntry(OTHER_TOKEN, 'ci')] },
  ])
  const ok = await httpRequest(PORT, '/gallery/api/whoami', { headers: bearer(TOKEN) })
  assert.equal(ok.status, 200)
})

/*--------------------------------- publish 拒绝分支 ---------------------------------*/

test('publish: 无 token 401', async () => {
  const data = await readFile(vsixPath)
  const r = await httpRequest(PORT, '/gallery/api/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: data,
  })
  assert.equal(r.status, 401)
})

test('publish: 坏 zip 400', async () => {
  const r = await httpRequest(PORT, '/gallery/api/publish', {
    method: 'POST',
    headers: { ...bearer(TOKEN), 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('this is not a zip file at all'),
  })
  assert.equal(r.status, 400)
  assert.match(r.body, /invalid vsix/i)
})

test('publish: manifest 缺 publisher 400（zod 过后市场强校验兜底）', async () => {
  const noPub = join(root, 'no-publisher.vsix')
  const m = demoManifest()
  delete m.publisher
  makeTestVsix(noPub, m)
  const r = await postVsix(PORT, '/gallery/api/publish', TOKEN, noPub)
  assert.equal(r.status, 400)
  assert.match(r.body, /publisher/)
})

test('publish: manifest 缺 engines.universe 400（zod schema 拒绝）', async () => {
  const noEngine = join(root, 'no-engine.vsix')
  const m = demoManifest()
  delete m.engines
  makeTestVsix(noEngine, m)
  const r = await postVsix(PORT, '/gallery/api/publish', TOKEN, noEngine)
  assert.equal(r.status, 400)
})

test('publish: token 归属与 manifest publisher 不符 403', async () => {
  // OTHER_TOKEN 属于 globex，但 fixture manifest publisher 是 acme
  const r = await postVsix(PORT, '/gallery/api/publish', OTHER_TOKEN, vsixPath)
  assert.equal(r.status, 403)
  assert.match(r.body, /does not match/)
})

test('publish: 已存在版本 409（版本不可变）', async () => {
  const taken = join(root, 'taken.vsix')
  makeTestVsix(taken, demoManifest({ name: 'taken', version: '1.0.0' }))
  const r = await postVsix(PORT, '/gallery/api/publish', TOKEN, taken)
  assert.equal(r.status, 409)
  assert.match(r.body, /immutable/)
})

/*--------------------------------- publish happy path ---------------------------------*/

test('publish: happy path → 201，资产落地 + registry 更新 + extensionquery 立即可见', async () => {
  const r = await postVsix(PORT, '/gallery/api/publish', TOKEN, vsixPath)
  assert.equal(r.status, 201)
  assert.deepEqual(JSON.parse(r.body), { id: 'acme.demo', version: '1.0.0' })

  const assetDir = join(galleryRoot, 'assets', 'acme.demo', '1.0.0')
  assert.ok(existsSync(join(assetDir, 'acme.demo-1.0.0.vsix')), 'vsix 规范名落地')
  assert.ok(existsSync(join(assetDir, 'icon.png')), 'icon 抽取落地')
  assert.ok(existsSync(join(assetDir, 'README.md')), 'README 抽取落地')

  const registry = JSON.parse(await readFile(join(galleryRoot, 'registry.json'), 'utf8'))
  const ext = registry.extensions.find((e) => e.publisher === 'acme' && e.name === 'demo')
  assert.ok(ext, 'registry 含新扩展')
  assert.equal(ext.versions[0].version, '1.0.0')
  assert.equal(ext.versions[0].assetDir, 'assets/acme.demo/1.0.0')
  assert.equal(ext.versions[0].files.vsix, 'acme.demo-1.0.0.vsix')
  assert.equal(ext.versions[0].engine, '^0.1.0')

  // 服务端重建的市场文件须保持组可写（registry 0664、版本目录 02775、资产文件 0664），
  // 否则 scp 发布通道会被自己写出的 644 锁死。
  if (process.platform !== 'win32') {
    const mode = async (p) => (await stat(p)).mode & 0o7777
    assert.equal(await mode(join(galleryRoot, 'registry.json')), 0o664, 'registry.json 组可写')
    assert.equal(await mode(assetDir), 0o2775, '版本目录 02775 setgid')
    assert.equal(
      await mode(join(assetDir, 'acme.demo-1.0.0.vsix')),
      0o664,
      '资产文件组可写',
    )
  }

  // 缓存显式失效：紧随 publish 的搜索必须立刻可见（不等 mtime tick）
  const hits = await queryExtension(PORT, '/', 'acme.demo')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].publisher.publisherName, 'acme')
})

test('publish: 同版本再发 409', async () => {
  const r = await postVsix(PORT, '/gallery/api/publish', TOKEN, vsixPath)
  assert.equal(r.status, 409)
})

test('publish: 新版本可发，versions 按 semver 降序且 extensionquery 见最新', async () => {
  const v110 = join(root, 'demo-1.1.0.vsix')
  makeTestVsix(v110, demoManifest({ version: '1.1.0' }))
  const r = await postVsix(PORT, '/gallery/api/publish', TOKEN, v110)
  assert.equal(r.status, 201)
  const registry = JSON.parse(await readFile(join(galleryRoot, 'registry.json'), 'utf8'))
  const ext = registry.extensions.find((e) => e.publisher === 'acme' && e.name === 'demo')
  assert.deepEqual(
    ext.versions.map((v) => v.version),
    ['1.1.0', '1.0.0'],
  )
  const hits = await queryExtension(PORT, '/', 'acme.demo')
  assert.equal(hits[0].versions[0].version, '1.1.0')
})

/*--------------------------------- publish 签名 ---------------------------------*/

test('publish: 版本条目带 sha256 + ed25519 签名，公钥白盒验签通过', async () => {
  const signedVsix = join(root, 'signed.vsix')
  makeTestVsix(signedVsix, demoManifest({ name: 'signed' }))
  const r = await postVsix(PORT, '/gallery/api/publish', TOKEN, signedVsix)
  assert.equal(r.status, 201)

  const registry = JSON.parse(await readFile(join(galleryRoot, 'registry.json'), 'utf8'))
  const ext = registry.extensions.find((e) => e.publisher === 'acme' && e.name === 'signed')
  const entry = ext?.versions?.[0]
  assert.ok(entry, 'registry 含新扩展版本条目')

  const vsixBytes = await readFile(signedVsix)
  const expectSha = createHash('sha256').update(vsixBytes).digest('hex')
  assert.equal(entry.sha256, expectSha, 'sha256 与上传 vsix 实算一致')
  assert.equal(entry.signature?.algorithm, 'ed25519')
  assert.equal(entry.signature?.keyId, signing.keyId)
  assert.ok(
    verify(null, vsixBytes, signing.publicKey, Buffer.from(entry.signature.value, 'base64')),
    '公钥验签通过',
  )
})

test('publish: extensionquery 版本 properties 带 VsixHash/VsixSignature/SignatureKeyId', async () => {
  const hits = await queryExtension(PORT, '/', 'acme.signed')
  assert.equal(hits.length, 1)
  const props = new Map(hits[0].versions[0].properties.map((p) => [p.key, p.value]))
  assert.match(props.get('Universe.Editor.VsixHash') ?? '', /^[0-9a-f]{64}$/)
  assert.ok(props.get('Universe.Editor.VsixSignature'), '含签名值')
  assert.equal(props.get('Universe.Editor.SignatureKeyId'), signing.keyId)
})

test('publish: 未配置签名私钥 → 503（whoami/unpublish 不受影响）', async () => {
  const noKey = await spawnServer({
    root,
    port: 39225,
    extraArgs: ['--gallery-root', galleryRoot, '--auth-dir', authDir],
  })
  try {
    const r = await postVsix(39225, '/gallery/api/publish', TOKEN, vsixPath)
    assert.equal(r.status, 503)
    assert.match(r.body, /signing key/)
    const who = await httpRequest(39225, '/gallery/api/whoami', { headers: bearer(TOKEN) })
    assert.equal(who.status, 200)
  } finally {
    noKey.child.kill()
  }
})

test('启动自检: --signing-key-file 不存在 / 坏内容 → 拒绝启动', async () => {
  for (const [label, keyFile] of [
    ['不存在', join(root, 'no-such-key.pem')],
    ['坏内容', join(root, 'bad-key.pem')],
  ]) {
    if (label === '坏内容') await writeFile(keyFile, 'this is not a pem')
    const bad = spawn(process.execPath, [
      serverScript,
      '--root',
      root,
      '--port',
      '39226',
      '--base',
      '/',
      '--signing-key-file',
      keyFile,
    ])
    let output = ''
    bad.stdout.on('data', (c) => (output += c))
    bad.stderr.on('data', (c) => (output += c))
    const code = await new Promise((r) => bad.on('exit', r))
    assert.notEqual(code, 0, `${label} 的私钥必须拒绝启动`)
    assert.match(output, /--signing-key-file/)
  }
})

/*--------------------------------- unpublish ---------------------------------*/

test('unpublish: 无 token 401 / 他人 publisher 403 / 不存在 404', async () => {
  const noAuth = await httpRequest(PORT, '/gallery/api/unpublish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'acme.demo', version: null }),
  })
  assert.equal(noAuth.status, 401)

  const foreign = await httpRequest(PORT, '/gallery/api/unpublish', {
    method: 'POST',
    headers: { ...bearer(OTHER_TOKEN), 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'acme.demo', version: null }),
  })
  assert.equal(foreign.status, 403)

  const missing = await httpRequest(PORT, '/gallery/api/unpublish', {
    method: 'POST',
    headers: { ...bearer(TOKEN), 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'acme.nonexistent', version: null }),
  })
  assert.equal(missing.status, 404)
})

test('unpublish: 按版本下架删资产目录，extensionquery 同步反映', async () => {
  const r = await httpRequest(PORT, '/gallery/api/unpublish', {
    method: 'POST',
    headers: { ...bearer(TOKEN), 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'acme.demo', version: '1.0.0' }),
  })
  assert.equal(r.status, 200)
  assert.deepEqual(JSON.parse(r.body), { removed: 'acme.demo@1.0.0' })
  assert.ok(!existsSync(join(galleryRoot, 'assets', 'acme.demo', '1.0.0')), '版本资产目录已删')
  const registry = JSON.parse(await readFile(join(galleryRoot, 'registry.json'), 'utf8'))
  const ext = registry.extensions.find((e) => e.publisher === 'acme' && e.name === 'demo')
  assert.deepEqual(
    ext.versions.map((v) => v.version),
    ['1.1.0'],
  )
})

test('unpublish: 整扩展下架（version=null）', async () => {
  const r = await httpRequest(PORT, '/gallery/api/unpublish', {
    method: 'POST',
    headers: { ...bearer(TOKEN), 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'acme.demo', version: null }),
  })
  assert.equal(r.status, 200)
  assert.ok(!existsSync(join(galleryRoot, 'assets', 'acme.demo')), '扩展资产目录整体已删')
  const hits = await queryExtension(PORT, '/', 'acme.demo')
  assert.equal(hits.length, 0)
})

/*--------------------------------- 启动自检与体积上限（独立实例） ---------------------------------*/

test('启动自检: --auth-dir 落在 galleryRoot 之内 → 拒绝启动', async () => {
  const bad = spawn(process.execPath, [
    serverScript,
    '--root',
    root,
    '--gallery-root',
    galleryRoot,
    '--auth-dir',
    join(galleryRoot, 'auth'),
    '--port',
    '39221',
    '--base',
    '/',
  ])
  let output = ''
  bad.stdout.on('data', (c) => (output += c))
  bad.stderr.on('data', (c) => (output += c))
  const code = await new Promise((r) => bad.on('exit', r))
  assert.notEqual(code, 0)
  assert.match(output, /--auth-dir/)
})

test('publish: 超过 --max-vsix-size 413', async () => {
  const tiny = await spawnServer({
    root,
    port: 39222,
    extraArgs: [
      '--gallery-root',
      galleryRoot,
      '--auth-dir',
      authDir,
      '--max-vsix-size',
      '256',
      ...signing.args,
    ],
  })
  try {
    const r = await postVsix(39222, '/gallery/api/publish', TOKEN, vsixPath)
    assert.equal(r.status, 413)
  } finally {
    tiny.child.kill()
  }
})
