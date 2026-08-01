/*---------------------------------------------------------------------------------------------
 *  scripts/gallery/token.mjs 运维工具测试（node --test）：
 *  issue 打明文存哈希 / 隐式建 publisher / 重复 label 拒 / 非法名拒 / 缺 auth-dir 拒；
 *  revoke 打戳 / 未知 label 报错；list 不泄露哈希。
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashToken } from '../../server/__tests__/publish-fixture.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const tokenScript = join(__dirname, '..', 'token.mjs')

function runToken(args) {
  return spawnSync(process.execPath, [tokenScript, ...args], { encoding: 'utf8' })
}

async function freshAuthDir() {
  return join(await mkdtemp(join(tmpdir(), 'ue-token-')), 'auth')
}

test('issue: 打印明文一次，publishers.json 只存哈希，publisher 隐式创建', async () => {
  const authDir = await freshAuthDir()
  const r = runToken(['issue', '--publisher', 'acme', '--label', 'laptop', '--auth-dir', authDir])
  assert.equal(r.status, 0, r.stderr)

  const token = /(uet_[A-Za-z0-9_-]+)/.exec(r.stdout)?.[1]
  assert.ok(token, `stdout 应含明文 token:\n${r.stdout}`)
  assert.match(r.stdout, /只打印这一次/)

  const data = JSON.parse(await readFile(join(authDir, 'publishers.json'), 'utf8'))
  assert.equal(data.publishers.length, 1)
  assert.equal(data.publishers[0].name, 'acme')
  const entry = data.publishers[0].tokens[0]
  assert.equal(entry.label, 'laptop')
  assert.equal(entry.hash, hashToken(token))
  assert.equal(entry.revoked, null)
  assert.ok(!JSON.stringify(data).includes(token), '落盘内容不得含明文 token')
})

test('issue: 同 publisher 重复未吊销 label 拒绝', async () => {
  const authDir = await freshAuthDir()
  runToken(['issue', '--publisher', 'acme', '--label', 'laptop', '--auth-dir', authDir])
  const dup = runToken(['issue', '--publisher', 'acme', '--label', 'laptop', '--auth-dir', authDir])
  assert.notEqual(dup.status, 0)
  assert.match(dup.stderr, /label/)
})

test('issue: publisher 名非法拒绝（与 uex login 校验一致）', async () => {
  const authDir = await freshAuthDir()
  const r = runToken(['issue', '--publisher', 'Acme_Bad', '--label', 'x', '--auth-dir', authDir])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /publisher/)
})

test('issue: 缺 --auth-dir 拒绝', () => {
  const r = runToken(['issue', '--publisher', 'acme', '--label', 'x'], {
    encoding: 'utf8',
  })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /auth-dir/)
})

test('revoke: 打吊销时间戳；未知 label 报错；list 不列哈希', async () => {
  const authDir = await freshAuthDir()
  runToken(['issue', '--publisher', 'acme', '--label', 'laptop', '--auth-dir', authDir])

  const listed = runToken(['list', '--auth-dir', authDir])
  assert.equal(listed.status, 0, listed.stderr)
  assert.match(listed.stdout, /acme\s+laptop/)
  assert.match(listed.stdout, /revoked=-/)
  assert.ok(!/[0-9a-f]{64}/.test(listed.stdout), 'list 不得输出哈希')

  const revoke = runToken(['revoke', '--publisher', 'acme', '--label', 'laptop', '--auth-dir', authDir])
  assert.equal(revoke.status, 0, revoke.stderr)
  const data = JSON.parse(await readFile(join(authDir, 'publishers.json'), 'utf8'))
  assert.ok(data.publishers[0].tokens[0].revoked, 'revoked 已打戳')

  const again = runToken(['revoke', '--publisher', 'acme', '--label', 'laptop', '--auth-dir', authDir])
  assert.notEqual(again.status, 0, '重复吊销应报错')

  const unknown = runToken(['revoke', '--publisher', 'acme', '--label', 'nope', '--auth-dir', authDir])
  assert.notEqual(unknown.status, 0)
})
