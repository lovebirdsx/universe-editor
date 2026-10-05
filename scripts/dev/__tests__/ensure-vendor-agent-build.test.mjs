/*---------------------------------------------------------------------------------------------
 *  scripts/dev/ensure-vendor-agent-build.mjs 纯逻辑单测。Run with `node --test`.
 *  覆盖：指纹对新增/删除/改动/测试文件/缺失路径的反应，以及 stale 判定的四个触发条件
 *  （stamp 缺记录、指纹不符、产物缺失、force）与 fast path 不误报。
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  STAMP_VERSION,
  VENDORS,
  fingerprint,
  selectStaleVendors,
} from '../ensure-vendor-agent-build.mjs'
import { mkTempDir, removeDirWithRetry } from '../../lib/temp-root.mjs'

function makeVendorTree(files) {
  const root = mkTempDir('vendor-agent-build-')
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

test('指纹对无关文件（测试/__tests__/node_modules）免疫', () => {
  const root = makeVendorTree({
    'src/index.ts': 'export const a = 1',
    'esbuild.config.mjs': 'build',
    'package.json': '{}',
    'package-lock.json': '{}',
    'dist/index.js': 'built',
  })
  try {
    const before = fingerprint([join(root, 'src')])
    mkdirSync(join(root, 'src/__tests__'), { recursive: true })
    mkdirSync(join(root, 'src/node_modules'), { recursive: true })
    writeFileSync(join(root, 'src/__tests__/x.test.ts'), 'noop')
    writeFileSync(join(root, 'src/foo.test.ts'), 'noop')
    writeFileSync(join(root, 'src/node_modules/dep.js'), 'noop')
    assert.equal(fingerprint([join(root, 'src')]), before)
  } finally {
    removeDirWithRetry(root)
  }
})

test('指纹对源码改动、新增、删除、目录缺失都敏感', () => {
  const root = makeVendorTree({ 'src/index.ts': 'export const a = 1' })
  try {
    const file = join(root, 'src/index.ts')
    // 显式拨开 mtime：Windows 时钟粒度下同长内容的连续改写可能拿到相同 mtimeMs，
    // 指纹（mtime+size，不读内容）会漏检，断言随平台抖动。
    const t0 = new Date(2020, 0, 1)
    utimesSync(file, t0, t0)
    const baseline = fingerprint([join(root, 'src')])

    writeFileSync(file, 'export const a = 2')
    const t1 = new Date(2021, 0, 1)
    utimesSync(file, t1, t1)
    const changed = fingerprint([join(root, 'src')])
    assert.notEqual(changed, baseline)

    writeFileSync(join(root, 'src/extra.ts'), 'export const b = 1')
    const added = fingerprint([join(root, 'src')])
    assert.notEqual(added, changed)

    rmSync(join(root, 'src/extra.ts'))
    assert.equal(fingerprint([join(root, 'src')]), changed)

    assert.notEqual(fingerprint([join(root, 'src-missing')]), added)
  } finally {
    removeDirWithRetry(root)
  }
})

test('指纹下限：新增文件即使 mtime 与既有文件相同也改变指纹', () => {
  const root = makeVendorTree({ 'src/a.ts': 'a' })
  try {
    const t = new Date()
    utimesSync(join(root, 'src/a.ts'), t, t)
    const before = fingerprint([join(root, 'src')])
    writeFileSync(join(root, 'src/b.ts'), 'a')
    utimesSync(join(root, 'src/b.ts'), t, t)
    assert.notEqual(fingerprint([join(root, 'src')]), before)
  } finally {
    removeDirWithRetry(root)
  }
})

test('fast path：stamp 指纹相符且产物存在时不重建', () => {
  const entries = [{ name: 'claude-agent-acp', hash: 'h1', output: '/nope/dist/index.js' }]
  const stale = selectStaleVendors(entries, { 'claude-agent-acp': 'h1' }, { exists: () => true })
  assert.deepEqual(stale, [])
})

test('指纹不符时重建', () => {
  const entries = [{ name: 'claude-agent-acp', hash: 'h2', output: '/nope/dist/index.js' }]
  const stale = selectStaleVendors(entries, { 'claude-agent-acp': 'h1' }, { exists: () => true })
  assert.deepEqual(stale, ['claude-agent-acp'])
})

test('stamp 无记录（首跑 / 新 vendor / stamp 损坏）时重建', () => {
  const entries = [
    { name: 'claude-agent-acp', hash: 'h1', output: '/nope/a.js' },
    { name: 'codex-acp', hash: 'h2', output: '/nope/b.js' },
  ]
  assert.deepEqual(
    selectStaleVendors(entries, {}, { exists: () => true }).sort(),
    ['claude-agent-acp', 'codex-acp'],
    'stamp 全空时两个 vendor 都要重建',
  )
  assert.deepEqual(
    selectStaleVendors(entries, { 'claude-agent-acp': 'h1' }, { exists: () => true }),
    ['codex-acp'],
    'stamp 只记了其中一个时另一个仍要重建',
  )
})

test('stamp 命中但产物缺失（构建中断 / dist 被清）时重建', () => {
  const entries = [{ name: 'claude-agent-acp', hash: 'h1', output: '/nope/dist/index.js' }]
  const stale = selectStaleVendors(entries, { 'claude-agent-acp': 'h1' }, { exists: () => false })
  assert.deepEqual(stale, ['claude-agent-acp'])
})

test('force 时忽略 stamp 与产物存在性全部重建', () => {
  const entries = [
    { name: 'claude-agent-acp', hash: 'h1', output: '/nope/a.js' },
    { name: 'codex-acp', hash: 'h2', output: '/nope/b.js' },
  ]
  assert.deepEqual(
    selectStaleVendors(
      entries,
      { 'claude-agent-acp': 'h1', 'codex-acp': 'h2' },
      { force: true, exists: () => true },
    ),
    ['claude-agent-acp', 'codex-acp'],
  )
})

test('VENDORS 表覆盖两个内置 agent，输入面含构建脚本与依赖清单', () => {
  assert.deepEqual(VENDORS.map((v) => v.name).sort(), ['claude-agent-acp', 'codex-acp'])
  for (const vendor of VENDORS) {
    assert.ok(vendor.inputs.includes('src'), `${vendor.name} 输入面缺 src`)
    assert.ok(vendor.inputs.includes('package-lock.json'), `${vendor.name} 输入面缺 lock`)
    assert.equal(vendor.output, 'dist/index.js')
  }
  assert.equal(STAMP_VERSION, 1)
})
