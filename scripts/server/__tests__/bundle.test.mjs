/*---------------------------------------------------------------------------------------------
 *  部署产物冒烟：esbuild bundle 出的 dist/server.js 必须能脱离 node_modules 独立运行——
 *  health 200 + whoami 401 + publish happy 201（证明 adm-zip/zod 已内联）。
 *  每次重跑 bundle.mjs，顺带验证 bundle 构建本身可用。
 *--------------------------------------------------------------------------------------------*/

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bearer,
  demoManifest,
  httpRequest,
  makeTestVsix,
  makeTokenEntry,
  postVsix,
  spawnServer,
  writePublishers,
} from './publish-fixture.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const bundleScript = join(__dirname, '..', 'bundle.mjs')
const bundleOut = join(__dirname, '..', 'dist', 'server.js')
const PORT = 39224
const TOKEN = 'uet_bundle_smoke_token_0000000000000'

let root
let child

before(async () => {
  const built = spawnSync(process.execPath, [bundleScript], { encoding: 'utf8' })
  assert.equal(built.status, 0, `bundle 构建失败: ${built.stderr}`)

  root = await mkdtemp(join(tmpdir(), 'ue-bundle-smoke-'))
  const galleryRoot = join(root, 'gallery')
  const authDir = `${root}-auth`
  await mkdir(galleryRoot, { recursive: true })
  await writeFile(join(galleryRoot, 'registry.json'), JSON.stringify({ extensions: [] }))
  await writePublishers(authDir, [{ name: 'acme', tokens: [makeTokenEntry(TOKEN, 'ci')] }])
  makeTestVsix(join(root, 'fixture.vsix'), demoManifest())
  ;({ child } = await spawnServer({
    root,
    port: PORT,
    script: bundleOut,
    extraArgs: ['--gallery-root', galleryRoot, '--auth-dir', authDir],
  }))
})

after(() => {
  if (child) child.kill()
})

test('bundle 产物: whoami 401（无 token）/ 200（正确 token）', async () => {
  const noAuth = await httpRequest(PORT, '/gallery/api/whoami')
  assert.equal(noAuth.status, 401)
  const ok = await httpRequest(PORT, '/gallery/api/whoami', { headers: bearer(TOKEN) })
  assert.equal(ok.status, 200)
  assert.deepEqual(JSON.parse(ok.body), { publisher: 'acme' })
})

test('bundle 产物: publish happy path 201（zod/adm-zip 已内联）', async () => {
  const r = await postVsix(PORT, '/gallery/api/publish', TOKEN, join(root, 'fixture.vsix'))
  assert.equal(r.status, 201)
  assert.deepEqual(JSON.parse(r.body), { id: 'acme.demo', version: '1.0.0' })
})
