/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Integration tests for server.mjs HTTP behavior. Run with `node --test`.
 *  起一个真实的 server 子进程，验证下载页回退、缓存头与路径穿越防护。
 *--------------------------------------------------------------------------------------------*/

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverScript = join(__dirname, '..', 'server.mjs')
const PORT = 39217
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

function httpPost(path, bodyObj) {
  const payload = JSON.stringify(bodyObj)
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

// 构造一个覆盖多扩展/多字段的 registry，供市场路由用例断言过滤/排序/资产 URL。
const REGISTRY = {
  extensions: [
    {
      publisher: 'acme',
      name: 'demo',
      displayName: 'Demo Tool',
      shortDescription: 'a demo extension',
      categories: ['AI'],
      versions: [
        {
          version: '1.2.3',
          lastUpdated: '2026-01-02T00:00:00Z',
          engine: '^0.1.0',
          assetDir: 'assets/acme.demo/1.2.3',
          files: { vsix: 'acme.demo-1.2.3.vsix', icon: 'icon.png', readme: 'README.md' },
          installCount: 100,
        },
      ],
    },
    {
      publisher: 'globex',
      name: 'widget',
      displayName: 'Widget',
      shortDescription: 'another one',
      categories: ['Other'],
      versions: [
        {
          version: '0.5.0',
          lastUpdated: '2026-03-01T00:00:00Z',
          engine: '^0.1.0',
          assetDir: 'assets/globex.widget/0.5.0',
          files: { vsix: 'globex.widget-0.5.0.vsix' },
          installCount: 5000,
        },
      ],
    },
  ],
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

  // 市场子树
  const galleryDir = join(root, 'gallery')
  await mkdir(galleryDir, { recursive: true })
  await writeFile(join(galleryDir, 'registry.json'), JSON.stringify(REGISTRY))
  await writeFile(
    join(galleryDir, 'control.json'),
    JSON.stringify({ malicious: ['evil.ext'], deprecated: {} }),
  )
  const vsixDir = join(galleryDir, 'assets', 'acme.demo', '1.2.3')
  await mkdir(vsixDir, { recursive: true })
  await writeFile(join(vsixDir, 'acme.demo-1.2.3.vsix'), 'PKZIPfakevsixbody')

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

/*--------------------------------- 市场路由 ---------------------------------*/

test('POST extensionquery 搜索命中并生成绝对资产 URL', async () => {
  const r = await httpPost(`${BASE}extensionquery`, {
    filters: [
      {
        criteria: [
          { filterType: 8, value: 'Universe.Editor' },
          { filterType: 10, value: 'demo' },
        ],
        pageNumber: 1,
        pageSize: 50,
        sortBy: 0,
        sortOrder: 0,
      },
    ],
    flags: 0x200,
  })
  assert.equal(r.status, 200)
  assert.match(r.headers['cache-control'], /no-store/)
  const data = JSON.parse(r.body)
  const exts = data.results[0].extensions
  assert.equal(exts.length, 1)
  assert.equal(exts[0].extensionName, 'demo')
  const vsix = exts[0].versions[0].files.find(
    (f) => f.assetType === 'Microsoft.VisualStudio.Services.VSIXPackage',
  )
  assert.equal(
    vsix.source,
    `http://127.0.0.1:${PORT}${BASE}gallery/assets/acme.demo/1.2.3/acme.demo-1.2.3.vsix`,
  )
  // 引擎属性写进 properties[]
  assert.equal(exts[0].versions[0].properties[0].key, 'Universe.Editor.Engine')
  // TotalCount 元数据
  const total = data.results[0].resultMetadata[0].metadataItems[0].count
  assert.equal(total, 1)
})

test('POST extensionquery 按 installCount 降序排序', async () => {
  const r = await httpPost(`${BASE}extensionquery`, {
    filters: [{ criteria: [], pageNumber: 1, pageSize: 50, sortBy: 4, sortOrder: 2 }],
    flags: 0x200,
  })
  const exts = JSON.parse(r.body).results[0].extensions
  assert.equal(exts.length, 2)
  assert.equal(exts[0].extensionName, 'widget') // installCount 5000 > 100
})

test('POST extensionquery 按 ExtensionName 精确取', async () => {
  const r = await httpPost(`${BASE}extensionquery`, {
    filters: [
      { criteria: [{ filterType: 7, value: 'globex.widget' }], pageNumber: 1, pageSize: 50 },
    ],
    flags: 0x200,
  })
  const exts = JSON.parse(r.body).results[0].extensions
  assert.equal(exts.length, 1)
  assert.equal(exts[0].publisher.publisherName, 'globex')
})

test('POST extensionquery 无匹配返回空但结构完整', async () => {
  const r = await httpPost(`${BASE}extensionquery`, {
    filters: [
      { criteria: [{ filterType: 10, value: 'zzznotexist' }], pageNumber: 1, pageSize: 50 },
    ],
    flags: 0x200,
  })
  assert.equal(r.status, 200)
  const data = JSON.parse(r.body)
  assert.equal(data.results[0].extensions.length, 0)
})

test('extensionquery 非法 JSON 返回 400', async () => {
  const r = await new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: PORT, path: `${BASE}extensionquery`, method: 'POST' },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode, body }))
      },
    )
    req.on('error', reject)
    req.end('{ not json')
  })
  assert.equal(r.status, 400)
})

test('GET control.json 返回恶意清单且禁缓存', async () => {
  const r = await httpGet(`${BASE}control.json`)
  assert.equal(r.status, 200)
  assert.match(r.headers['content-type'], /application\/json/)
  assert.match(r.headers['cache-control'], /no-store/)
  const data = JSON.parse(r.body)
  assert.deepEqual(data.malicious, ['evil.ext'])
})

test('GET vsix 静态下载支持 Range', async () => {
  const r = await new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: `${BASE}gallery/assets/acme.demo/1.2.3/acme.demo-1.2.3.vsix`,
        method: 'GET',
        headers: { Range: 'bytes=0-2' },
      },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
  assert.equal(r.status, 206)
  assert.match(r.headers['content-range'], /bytes 0-2\//)
  assert.equal(r.body, 'PKZ')
})

/*--------------------- 更新根与市场根解耦（--gallery-root） ---------------------*/

test('--gallery-root 指向独立目录时，更新与市场各自服务', async () => {
  const PORT2 = 39218
  const updateRoot = await mkdtemp(join(tmpdir(), 'ue-upd-'))
  const galleryRoot = await mkdtemp(join(tmpdir(), 'ue-gal-'))
  // 更新根：只有更新产物，无 gallery 子目录
  await writeFile(join(updateRoot, 'latest.yml'), 'version: 1.0.0\n')
  // 市场根：独立位置，直接放 registry/control/assets
  await writeFile(join(galleryRoot, 'registry.json'), JSON.stringify(REGISTRY))
  await writeFile(join(galleryRoot, 'control.json'), JSON.stringify({ malicious: ['x.y'] }))
  const aDir = join(galleryRoot, 'assets', 'acme.demo', '1.2.3')
  await mkdir(aDir, { recursive: true })
  await writeFile(join(aDir, 'acme.demo-1.2.3.vsix'), 'ZIPBODY')

  const proc = spawn(
    process.execPath,
    [
      serverScript,
      '--root',
      updateRoot,
      '--gallery-root',
      galleryRoot,
      '--port',
      String(PORT2),
      '--base',
      BASE,
    ],
    { stdio: 'ignore' },
  )
  const call = (method, path, body) =>
    new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined
      const req = request(
        {
          host: '127.0.0.1',
          port: PORT2,
          path,
          method,
          headers: payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {},
        },
        (res) => {
          let b = ''
          res.on('data', (c) => (b += c))
          res.on('end', () => resolve({ status: res.statusCode, body: b }))
        },
      )
      req.on('error', reject)
      req.end(payload)
    })

  try {
    // 等待就绪
    const start = Date.now()
    for (;;) {
      try {
        const r = await call('GET', '/')
        if (r.status === 200) break
      } catch {
        /* 未就绪 */
      }
      if (Date.now() - start > 8000) throw new Error('server 启动超时')
      await new Promise((r) => setTimeout(r, 100))
    }

    // 更新产物从更新根服务
    assert.equal((await call('GET', `${BASE}latest.yml`)).status, 200)

    // 市场从独立市场根服务
    const q = await call('POST', `${BASE}extensionquery`, {
      filters: [{ criteria: [{ filterType: 10, value: 'demo' }], pageNumber: 1, pageSize: 50 }],
      flags: 0x200,
    })
    const data = JSON.parse(q.body)
    assert.equal(data.results[0].extensions.length, 1)
    const vsix = data.results[0].extensions[0].versions[0].files.find(
      (f) => f.assetType === 'Microsoft.VisualStudio.Services.VSIXPackage',
    )
    // 资产 URL 仍是 gallery/ 命名空间，但落盘在独立市场根
    assert.match(vsix.source, /\/gallery\/assets\/acme\.demo\/1\.2\.3\//)
    const dl = await call('GET', `${BASE}gallery/assets/acme.demo/1.2.3/acme.demo-1.2.3.vsix`)
    assert.equal(dl.status, 200)
    assert.equal(dl.body, 'ZIPBODY')

    // control.json 从独立市场根
    assert.deepEqual(JSON.parse((await call('GET', `${BASE}control.json`)).body).malicious, ['x.y'])
  } finally {
    proc.kill()
  }
})
