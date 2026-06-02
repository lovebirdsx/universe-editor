/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Integration tests for server.mjs HTTP behavior. Run with `node --test`.
 *  起一个真实的 server 子进程，验证下载页回退、缓存头与路径穿越防护。
 *--------------------------------------------------------------------------------------------*/

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverScript = join(__dirname, '..', 'server.mjs')
const PORT = 38217
const BASE = '/universe-editor/'

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, path, method: 'GET' }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

let child
let root

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'ue-server-'))
  await writeFile(join(root, 'index.html'), '<!doctype html><title>dl</title>OK-INDEX')
  await writeFile(
    join(root, 'latest.yml'),
    'version: 9.9.9\nfiles:\n  - url: app.exe\n    size: 10\n',
  )
  await writeFile(join(root, 'release-notes.json'), '[]')

  child = spawn(
    process.execPath,
    [serverScript, '--root', root, '--port', String(PORT), '--base', BASE],
    { stdio: 'ignore' },
  )

  const start = Date.now()
  for (;;) {
    try {
      const r = await httpGet('/')
      if (r.status === 200) break
    } catch {
      /* 尚未就绪，继续轮询 */
    }
    if (Date.now() - start > 8000) throw new Error('server 启动超时')
    await new Promise((r) => setTimeout(r, 100))
  }
})

after(() => {
  if (child) child.kill()
})

test('base 根目录回退到 index.html', async () => {
  const r = await httpGet(BASE)
  assert.equal(r.status, 200)
  assert.match(r.headers['content-type'], /text\/html/)
  assert.match(r.body, /OK-INDEX/)
  assert.match(r.headers['cache-control'], /no-store/)
})

test('index.html 显式请求返回 html 且禁缓存', async () => {
  const r = await httpGet(`${BASE}index.html`)
  assert.equal(r.status, 200)
  assert.match(r.headers['content-type'], /text\/html/)
  assert.match(r.headers['cache-control'], /no-store/)
})

test('release-notes.json 为 application/json 且禁缓存', async () => {
  const r = await httpGet(`${BASE}release-notes.json`)
  assert.equal(r.status, 200)
  assert.match(r.headers['content-type'], /application\/json/)
  assert.match(r.headers['cache-control'], /no-store/)
})

test('latest.yml 禁缓存（回归保护）', async () => {
  const r = await httpGet(`${BASE}latest.yml`)
  assert.equal(r.status, 200)
  assert.match(r.headers['cache-control'], /no-store/)
})

test('根路径 / 返回健康检查', async () => {
  const r = await httpGet('/')
  assert.equal(r.status, 200)
  assert.match(r.body, /universe-update-server ok/)
})

test('穿越尝试不泄露 root 外文件', async () => {
  const r = await httpGet(`${BASE}%2e%2e/%2e%2e/server.mjs`)
  assert.notEqual(r.status, 200)
})
