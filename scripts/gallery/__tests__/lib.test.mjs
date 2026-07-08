/*---------------------------------------------------------------------------------------------
 *  scripts/gallery 运维逻辑单测。Run with `node --test`.
 *  覆盖：VSIX 元数据抽取、registry upsert（覆盖/排序）、下架、以及 publish.mjs 端到端落盘。
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  compareVersions,
  metadataFromManifest,
  upsertVersion,
  removeFromRegistry,
} from '../lib.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..', '..')
const require = createRequire(resolve(repoRoot, 'packages/extension-packaging/package.json'))
const AdmZip = require('adm-zip')

function makeVsix(dir, manifest, extras = {}) {
  const zip = new AdmZip()
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'))
  zip.addFile('extension.vsixmanifest', Buffer.from('<PackageManifest/>'))
  zip.addFile('extension/package.json', Buffer.from(JSON.stringify(manifest)))
  for (const [rel, content] of Object.entries(extras)) {
    zip.addFile(`extension/${rel}`, Buffer.from(content))
  }
  const out = join(dir, `${manifest.publisher}.${manifest.name}-${manifest.version}.vsix`)
  zip.writeZip(out)
  return out
}

test('compareVersions 按 semver 比较', () => {
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1)
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1)
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1)
})

test('metadataFromManifest 抽取字段并强校验', () => {
  const meta = metadataFromManifest({
    publisher: 'acme',
    name: 'demo',
    version: '1.0.0',
    displayName: 'Demo',
    description: 'd',
    engines: { universe: '^0.1.0' },
    categories: ['AI'],
    icon: 'icon.png',
  })
  assert.equal(meta.publisher, 'acme')
  assert.equal(meta.engine, '^0.1.0')
  assert.equal(meta.iconRel, 'icon.png')
  assert.deepEqual(meta.categories, ['AI'])
})

test('metadataFromManifest 缺 publisher / engine 抛错', () => {
  assert.throws(
    () => metadataFromManifest({ name: 'x', version: '1.0.0', engines: { universe: '*' } }),
    /publisher/,
  )
  assert.throws(
    () => metadataFromManifest({ publisher: 'p', name: 'x', version: '1.0.0' }),
    /engines\.universe/,
  )
})

test('upsertVersion 新增后按 semver 降序，最新在首位', () => {
  const reg = { extensions: [] }
  const meta = { publisher: 'p', name: 'x', displayName: 'X', shortDescription: '' }
  upsertVersion(reg, meta, { version: '1.0.0', assetDir: 'a', files: {} })
  upsertVersion(reg, meta, { version: '1.2.0', assetDir: 'b', files: {} })
  upsertVersion(reg, meta, { version: '1.1.0', assetDir: 'c', files: {} })
  const versions = reg.extensions[0].versions.map((v) => v.version)
  assert.deepEqual(versions, ['1.2.0', '1.1.0', '1.0.0'])
})

test('upsertVersion 同版本覆盖并告警', () => {
  const reg = { extensions: [] }
  const meta = { publisher: 'p', name: 'x', displayName: 'X', shortDescription: '' }
  upsertVersion(reg, meta, { version: '1.0.0', assetDir: 'a', files: {} })
  const { warnings } = upsertVersion(reg, meta, { version: '1.0.0', assetDir: 'b', files: {} })
  assert.equal(reg.extensions[0].versions.length, 1)
  assert.equal(reg.extensions[0].versions[0].assetDir, 'b')
  assert.match(warnings.join(), /覆盖已存在版本/)
})

test('removeFromRegistry 删版本与删整个扩展', () => {
  const reg = {
    extensions: [
      {
        publisher: 'p',
        name: 'x',
        versions: [
          { version: '2.0.0', assetDir: 'd2' },
          { version: '1.0.0', assetDir: 'd1' },
        ],
      },
    ],
  }
  const r1 = removeFromRegistry(reg, 'p', 'x', '1.0.0')
  assert.equal(r1.found, true)
  assert.deepEqual(r1.removedAssetDirs, ['d1'])
  assert.equal(reg.extensions[0].versions.length, 1)

  const r2 = removeFromRegistry(reg, 'p', 'x')
  assert.equal(r2.found, true)
  assert.deepEqual(r2.removedAssetDirs, ['d2'])
  assert.equal(reg.extensions.length, 0)

  assert.equal(removeFromRegistry(reg, 'no', 'ne').found, false)
})

test('publish.mjs 端到端：写 registry + 落地 assets', () => {
  const stage = mkdtempSync(join(tmpdir(), 'ue-gallery-'))
  const vsixDir = mkdtempSync(join(tmpdir(), 'ue-vsix-'))
  const vsix = makeVsix(
    vsixDir,
    {
      publisher: 'acme',
      name: 'demo',
      version: '1.2.3',
      displayName: 'Demo',
      description: 'A demo',
      engines: { universe: '^0.1.0' },
      categories: ['Other'],
      icon: 'icon.png',
    },
    { 'icon.png': 'PNGDATA', 'README.md': '# Demo readme' },
  )

  const script = resolve(__dirname, '..', 'publish.mjs')
  const res = spawnSync(
    process.execPath,
    [script, '--stage', stage, '--now', '2026-07-08T00:00:00Z', vsix],
    { encoding: 'utf8' },
  )
  assert.equal(res.status, 0, res.stderr)

  const registry = JSON.parse(readFileSync(join(stage, 'gallery', 'registry.json'), 'utf8'))
  assert.equal(registry.extensions.length, 1)
  const ext = registry.extensions[0]
  assert.equal(ext.publisher, 'acme')
  assert.equal(ext.name, 'demo')
  const v = ext.versions[0]
  assert.equal(v.version, '1.2.3')
  assert.equal(v.engine, '^0.1.0')
  assert.equal(v.assetDir, 'assets/acme.demo/1.2.3')
  assert.equal(v.files.vsix, 'acme.demo-1.2.3.vsix')
  assert.equal(v.files.icon, 'icon.png')
  assert.equal(v.files.readme, 'README.md')

  const base = join(stage, 'gallery', 'assets', 'acme.demo', '1.2.3')
  assert.ok(existsSync(join(base, 'acme.demo-1.2.3.vsix')))
  assert.ok(existsSync(join(base, 'icon.png')))
  assert.equal(readFileSync(join(base, 'README.md'), 'utf8'), '# Demo readme')
})
