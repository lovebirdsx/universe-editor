/*---------------------------------------------------------------------------------------------
 *  publish API 相关测试的共享 fixture：现场打 VSIX、算 token 哈希、起 server、http 工具。
 *  （node --test 只收集 *.test.mjs，本文件是 helper 不会被当作测试。）
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import AdmZip from 'adm-zip'
import { request } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const repoRoot = join(__dirname, '..', '..', '..')
export const serverScript = join(__dirname, '..', 'server.mjs')

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

export function makeTokenEntry(token, label = 'test', revoked = null) {
  return { hash: hashToken(token), label, created: '2026-08-01T00:00:00Z', revoked }
}

// 现场打一个满足宿主 zod schema 的最小 VSIX（extension/package.json 必填：
// name/version/engines.universe；publisher 由市场侧 metadataFromManifest 强校验）。
export function makeTestVsix(path, manifest, { icon = true, readme = true } = {}) {
  const zip = new AdmZip()
  zip.addFile('extension/package.json', Buffer.from(JSON.stringify(manifest)))
  if (readme) zip.addFile('extension/README.md', Buffer.from('# test readme'))
  if (icon) zip.addFile('extension/icon.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  zip.writeZip(path)
  return path
}

export function demoManifest(overrides = {}) {
  return {
    name: 'demo',
    publisher: 'acme',
    version: '1.0.0',
    displayName: 'Demo',
    description: 'demo extension',
    engines: { universe: '^0.1.0' },
    main: './dist/extension.js',
    icon: 'icon.png',
    ...overrides,
  }
}

// 起 server 子进程并等就绪。extraArgs 形如 ['--max-vsix-size', '1024']。
export async function spawnServer({ root, port, base = '/', extraArgs = [], script = serverScript }) {
  const child = spawn(
    process.execPath,
    [script, '--root', root, '--port', String(port), '--base', base, ...extraArgs],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  child.stdout.on('data', (c) => (output += c))
  child.stderr.on('data', (c) => (output += c))
  const start = Date.now()
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server 启动失败 (exit ${child.exitCode})\n${output}`)
    }
    try {
      const r = await httpRequest(port, '/nonexistent-probe')
      if (r.status > 0) break
    } catch {
      /* 尚未就绪 */
    }
    if (Date.now() - start > 15000) {
      child.kill()
      throw new Error(`server 启动超时\n${output}`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return { child, output: () => output }
}

export function httpRequest(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      )
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

export function bearer(token) {
  return { Authorization: `Bearer ${token}` }
}

export async function postVsix(port, path, token, vsixPath) {
  const { readFile } = await import('node:fs/promises')
  const data = await readFile(vsixPath)
  return httpRequest(port, path, {
    method: 'POST',
    headers: {
      ...bearer(token),
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(data.byteLength),
    },
    body: data,
  })
}

// 把 publishers.json 落到 authDir。
export async function writePublishers(authDir, publishers) {
  await mkdir(authDir, { recursive: true })
  await writeFile(join(authDir, 'publishers.json'), JSON.stringify({ publishers }))
}

// 生成测试用 Ed25519 签名密钥：私钥 PEM 落盘（server 只认文件路径），
// 返回的 args 直接拼进 spawnServer extraArgs；publicKey 留给验签断言。
export async function makeSigningKey(dir, keyId = 'market-v1') {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const keyFile = join(dir, `signing-key-${keyId}.pem`)
  await writeFile(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  return {
    keyFile,
    keyId,
    publicKey,
    args: ['--signing-key-file', keyFile, '--signing-key-id', keyId],
  }
}

// 管理令牌：明文落盘（server 只认文件路径），返回的 args 直接拼进 spawnServer extraArgs。
export async function makeAdminToken(dir, token = 'test-admin-token') {
  const tokenFile = join(dir, 'admin-token.txt')
  await writeFile(tokenFile, `${token}\n`)
  return { token, tokenFile, args: ['--admin-token-file', tokenFile] }
}

// 市场搜索（按扩展名精确过滤），返回命中的扩展数组。
export async function queryExtension(port, base, fullName) {
  const r = await httpRequest(port, `${base}extensionquery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filters: [{ criteria: [{ filterType: 7, value: fullName }], pageNumber: 1, pageSize: 50 }],
      flags: 0x200,
    }),
  })
  assert.equal(r.status, 200)
  return JSON.parse(r.body).results[0].extensions
}
