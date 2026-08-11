/*---------------------------------------------------------------------------------------------
 *  uex CLI ↔ publish API 真联调（Phase D 完成标准）：真起 server，真跑构建出的 uex dist：
 *  login（whoami 验证 + 落配置）→ publish（走 stored 凭据）→ extensionquery 可见 →
 *  同版本 409 非零退出 → unpublish → 不可见。
 *  依赖 test:release 前置的 `turbo run build --filter=@universe-editor/uex` 产出 dist。
 *--------------------------------------------------------------------------------------------*/

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  demoManifest,
  makeSigningKey,
  makeTestVsix,
  makeTokenEntry,
  queryExtension,
  repoRoot,
  spawnServer,
  writePublishers,
} from './publish-fixture.mjs'

const PORT = 39223
const TOKEN = 'uet_uex_integration_token_00000000'
const uexCli = join(repoRoot, 'packages', 'uex', 'dist', 'cli.js')

let root
let galleryRoot
let authDir
let homeDir
let vsixPath
let child

function runUex(args) {
  return spawnSync(process.execPath, [uexCli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
  })
}

before(async () => {
  assert.ok(
    existsSync(uexCli),
    `缺少 ${uexCli} —— 请经 pnpm test:release 运行（前置 turbo build），或先 pnpm build`,
  )
  root = await mkdtemp(join(tmpdir(), 'ue-uex-integration-'))
  galleryRoot = join(root, 'gallery')
  authDir = `${root}-auth`
  homeDir = join(root, 'home')
  await mkdir(galleryRoot, { recursive: true })
  await mkdir(homeDir, { recursive: true })
  await writeFile(join(galleryRoot, 'registry.json'), JSON.stringify({ extensions: [] }))
  await writePublishers(authDir, [{ name: 'acme', tokens: [makeTokenEntry(TOKEN, 'ci')] }])
  vsixPath = join(root, 'fixture.vsix')
  makeTestVsix(vsixPath, demoManifest())
  const signing = await makeSigningKey(root)
  ;({ child } = await spawnServer({
    root,
    port: PORT,
    extraArgs: ['--gallery-root', galleryRoot, '--auth-dir', authDir, ...signing.args],
  }))
})

after(() => {
  if (child) child.kill()
})

test('uex login → publish → 409 → unpublish 全链路', async () => {
  const registry = `http://127.0.0.1:${PORT}`

  const login = runUex(['login', 'acme', '--registry', registry, '--token', TOKEN])
  assert.equal(login.status, 0, `login 失败: ${login.stderr}`)

  // publish 不带 --token / env，凭据须来自 login 写入的配置（tmp HOME 隔离）
  const publish = runUex(['publish', '--package-path', vsixPath, '--registry', registry])
  assert.equal(publish.status, 0, `publish 失败: ${publish.stderr}`)
  assert.match(publish.stdout, /acme\.demo@1\.0\.0|published/i)

  const hits = await queryExtension(PORT, '/', 'acme.demo')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].versions[0].version, '1.0.0')

  const republish = runUex(['publish', '--package-path', vsixPath, '--registry', registry])
  assert.notEqual(republish.status, 0, '同版本重发必须失败（409 版本不可变）')
  assert.match(republish.stderr, /409|immutable/i)

  const unpublish = runUex(['unpublish', 'acme.demo@1.0.0', '--registry', registry])
  assert.equal(unpublish.status, 0, `unpublish 失败: ${unpublish.stderr}`)

  const gone = await queryExtension(PORT, '/', 'acme.demo')
  assert.equal(gone.length, 0)
})
