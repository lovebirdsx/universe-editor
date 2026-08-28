/*---------------------------------------------------------------------------------------------
 *  Tests for runtime-resources.mjs pure helpers. Run with `node --test`.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  discoverBuiltinExtensions,
  extensionPackageFiles,
  resolveStagedProductJson,
} from '../runtime-resources.mjs'

test('extensionPackageFiles defaults to dist for executable extensions', () => {
  assert.deepEqual(extensionPackageFiles({ main: 'dist/extension.js' }), ['package.json', 'dist'])
})

test('extensionPackageFiles supports explicit shipped directories', () => {
  assert.deepEqual(
    extensionPackageFiles({
      main: 'server/index.js',
      files: ['./server', 'syntaxes/**', 'themes'],
    }),
    ['package.json', 'server', 'syntaxes', 'themes'],
  )
})

test('extensionPackageFiles rejects paths outside the extension root', () => {
  assert.throws(() => extensionPackageFiles({ files: ['../secret'] }), /must stay inside/)
  assert.throws(() => extensionPackageFiles({ files: ['C:/secret'] }), /must stay inside/)
  assert.throws(() => extensionPackageFiles({ files: ['dist/*.js'] }), /must be a literal/)
})

test('discoverBuiltinExtensions finds package folders in stable order', () => {
  const root = mkdtempSync(join(tmpdir(), 'ue-runtime-resources-'))
  try {
    mkdirSync(join(root, 'zeta'))
    mkdirSync(join(root, 'alpha'))
    mkdirSync(join(root, 'notes'))
    writeFileSync(join(root, 'zeta/package.json'), JSON.stringify({ name: 'zeta' }), 'utf8')
    writeFileSync(join(root, 'alpha/package.json'), JSON.stringify({ name: 'alpha' }), 'utf8')

    assert.deepEqual(
      discoverBuiltinExtensions(root).map((extension) => extension.id),
      ['alpha', 'zeta'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// build/product.json 的形状：JSONC，带注释与 galleryUrl 占位值，无 configurationDefaults。
const PRODUCT_JSONC = [
  '{',
  '  // 打包版内嵌的产品默认配置',
  '  "galleryUrl": "http://gallery.example.com:9999/universe-editor"',
  '',
  '  // configurationDefaults 刻意不在此声明占位值',
  '}',
  '',
].join('\n')

test('resolveStagedProductJson: 无任何 env 时返回 undefined（调用方走字节级拷贝）', () => {
  assert.equal(resolveStagedProductJson(PRODUCT_JSONC, {}), undefined)
})

test('resolveStagedProductJson: 只配 configurationDefaults 时写入该字段且保留 galleryUrl 占位值', () => {
  const staged = JSON.parse(
    resolveStagedProductJson(PRODUCT_JSONC, { UE_SWARM_URL: 'http://swarm.example.com/' }),
  )
  assert.deepEqual(staged, {
    galleryUrl: 'http://gallery.example.com:9999/universe-editor',
    configurationDefaults: { 'perforce.swarm.url': 'http://swarm.example.com/' },
  })
})

test('resolveStagedProductJson: 只配 UE_GALLERY_URL 时不写 configurationDefaults 字段', () => {
  const staged = JSON.parse(
    resolveStagedProductJson(PRODUCT_JSONC, { UE_GALLERY_URL: 'http://gallery.example.com/g' }),
  )
  assert.equal(staged.galleryUrl, 'http://gallery.example.com/g')
  assert.equal('configurationDefaults' in staged, false)
})

test('resolveStagedProductJson: 两者都配时各自生效，产出以换行结尾的合法 JSON', () => {
  const text = resolveStagedProductJson(PRODUCT_JSONC, {
    UE_GALLERY_URL: 'http://gallery.example.com/g',
    UE_TRACKER_SERVER_URL: 'http://tracker.example.com:3030',
    UE_TRACKER_APP_URL: 'http://tracker.example.com',
  })
  assert.ok(text.endsWith('\n'))
  assert.deepEqual(JSON.parse(text), {
    galleryUrl: 'http://gallery.example.com/g',
    configurationDefaults: {
      'issueReporter.tracker.serverUrl': 'http://tracker.example.com:3030',
      'issueReporter.tracker.appUrl': 'http://tracker.example.com',
    },
  })
})
