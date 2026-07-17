/*---------------------------------------------------------------------------------------------
 *  scripts/ext-release 纯逻辑单测。Run with `node --test`.
 *  覆盖：可发布性判定、自动发现（合法/跳过分流）、位置参数选择、增量判定。
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  alreadyPublished,
  discoverExtensions,
  filterIncremental,
  ineligibleReason,
  selectExtensions,
} from '../lib.mjs'

const validManifest = {
  name: 'demo',
  publisher: 'acme',
  version: '1.0.0',
  engines: { universe: '^0.1.0' },
}

/** 在临时目录铺一个 extensions-external 布局，返回根路径。 */
function makeExternalRoot(exts) {
  const root = mkdtempSync(join(tmpdir(), 'ext-release-'))
  for (const [dir, manifest] of Object.entries(exts)) {
    const d = join(root, dir)
    mkdirSync(d, { recursive: true })
    if (manifest !== null) writeFileSync(join(d, 'package.json'), JSON.stringify(manifest))
  }
  return root
}

test('ineligibleReason 接受合法 manifest', () => {
  assert.equal(ineligibleReason(validManifest), null)
})

test('ineligibleReason 拒绝 private / 缺字段', () => {
  assert.equal(ineligibleReason({ ...validManifest, private: true }), 'private')
  assert.match(ineligibleReason({ ...validManifest, publisher: undefined }), /publisher/)
  assert.match(ineligibleReason({ ...validManifest, version: undefined }), /version/)
  assert.match(ineligibleReason({ ...validManifest, engines: {} }), /engines\.universe/)
})

test('discoverExtensions 分流合法与跳过', () => {
  const root = makeExternalRoot({
    good: validManifest,
    priv: { ...validManifest, name: 'p', private: true },
    nopub: { ...validManifest, name: 'q', publisher: undefined },
    nojson: null, // 目录无 package.json → 直接忽略（不计入 skipped）
  })
  const { eligible, skipped } = discoverExtensions(root)
  assert.deepEqual(
    eligible.map((e) => e.id),
    ['acme.demo'],
  )
  assert.equal(eligible[0].version, '1.0.0')
  const skippedDirs = skipped.map((s) => s.dir).sort()
  assert.deepEqual(skippedDirs, ['nopub', 'priv'])
})

test('discoverExtensions 对不存在的根返回空', () => {
  const { eligible, skipped } = discoverExtensions(join(tmpdir(), 'nope-' + Math.random()))
  assert.deepEqual(eligible, [])
  assert.deepEqual(skipped, [])
})

test('selectExtensions 无参全选，按目录名/id 选择，未命中报错', () => {
  const all = [
    { dir: 'a', id: 'acme.a' },
    { dir: 'b', id: 'acme.b' },
  ]
  assert.equal(selectExtensions(all, []).selected.length, 2)
  assert.deepEqual(
    selectExtensions(all, ['b']).selected.map((e) => e.dir),
    ['b'],
  )
  assert.deepEqual(
    selectExtensions(all, ['acme.a']).selected.map((e) => e.dir),
    ['a'],
  )
  assert.match(selectExtensions(all, ['nope']).error, /未找到/)
})

test('alreadyPublished 命中 publisher.name@version', () => {
  const registry = {
    extensions: [{ publisher: 'acme', name: 'demo', versions: [{ version: '1.0.0' }] }],
  }
  const ext = { manifest: validManifest, version: '1.0.0' }
  assert.equal(alreadyPublished(registry, ext), true)
  assert.equal(alreadyPublished(registry, { manifest: validManifest, version: '1.0.1' }), false)
  assert.equal(alreadyPublished({ extensions: [] }, ext), false)
})

test('filterIncremental 跳过已发布，force 全量', () => {
  const registry = {
    extensions: [{ publisher: 'acme', name: 'demo', versions: [{ version: '1.0.0' }] }],
  }
  const selected = [
    { id: 'acme.demo', version: '1.0.0', manifest: validManifest },
    { id: 'acme.other', version: '2.0.0', manifest: { ...validManifest, name: 'other' } },
  ]
  const inc = filterIncremental(registry, selected, false)
  assert.deepEqual(
    inc.toPublish.map((e) => e.id),
    ['acme.other'],
  )
  assert.deepEqual(
    inc.skipped.map((e) => e.id),
    ['acme.demo'],
  )
  const forced = filterIncremental(registry, selected, true)
  assert.equal(forced.toPublish.length, 2)
  assert.equal(forced.skipped.length, 0)
})
