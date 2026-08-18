/*---------------------------------------------------------------------------------------------
 *  scripts/dev/ensure-fresh-mtimes.mjs 纯逻辑单测。Run with `node --test`.
 *  覆盖：未来 mtime 归一化、tsbuildinfo 删除、目录剪枝、容差边界、幂等。
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeFutureMtimes, TOLERANCE_MS } from '../ensure-fresh-mtimes.mjs'

const HOUR_MS = 3600_000

function makeTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'fresh-mtimes-'))
  const now = new Date()
  for (const [rel, offsetMs] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, rel)
    if (offsetMs !== 0) {
      const t = new Date(now.getTime() + offsetMs)
      utimesSync(abs, t, t)
    }
  }
  return { root, now }
}

test('未来 mtime 的普通文件被归一到 now，正常文件不动', () => {
  const { root, now } = makeTree({ 'src/a.ts': HOUR_MS, 'src/b.ts': 0 })
  const { removed, touched } = normalizeFutureMtimes(root, { now })
  assert.deepEqual(removed, [])
  assert.deepEqual(touched, [join(root, 'src/a.ts')])
  assert.ok(statSync(join(root, 'src/a.ts')).mtimeMs <= now.getTime() + TOLERANCE_MS)
  assert.ok(Math.abs(statSync(join(root, 'src/b.ts')).mtimeMs - now.getTime()) < HOUR_MS)
})

test('未来 mtime 的 tsbuildinfo 被删除而非 touch', () => {
  const { root, now } = makeTree({
    'pkg/tsconfig.tsbuildinfo': HOUR_MS,
    'dist/.tsbuildinfo-node': HOUR_MS,
    'pkg/normal.tsbuildinfo.bak': HOUR_MS,
    'pkg/keep.tsbuildinfo': 0,
  })
  const { removed, touched } = normalizeFutureMtimes(root, { now })
  assert.deepEqual(touched, [])
  assert.deepEqual(new Set(removed), new Set([
    join(root, 'pkg/tsconfig.tsbuildinfo'),
    join(root, 'dist/.tsbuildinfo-node'),
    join(root, 'pkg/normal.tsbuildinfo.bak'),
  ]))
  assert.equal(existsSync(join(root, 'pkg/tsconfig.tsbuildinfo')), false)
  assert.equal(existsSync(join(root, 'dist/.tsbuildinfo-node')), false)
  assert.equal(existsSync(join(root, 'pkg/keep.tsbuildinfo')), true)
})

test('node_modules / .git 下的未来文件被剪枝跳过', () => {
  const { root, now } = makeTree({
    'node_modules/dep/index.js': HOUR_MS,
    '.git/objects/x': HOUR_MS,
    'src/a.ts': HOUR_MS,
  })
  const { removed, touched } = normalizeFutureMtimes(root, { now })
  assert.deepEqual(removed, [])
  assert.deepEqual(touched, [join(root, 'src/a.ts')])
  assert.ok(statSync(join(root, 'node_modules/dep/index.js')).mtimeMs > now.getTime())
})

test('容差边界：容差内不动，超容差归一', () => {
  const { root, now } = makeTree({ 'near.ts': 30_000, 'far.ts': 5 * 60_000 })
  const { touched } = normalizeFutureMtimes(root, { now })
  assert.deepEqual(touched, [join(root, 'far.ts')])
})

test('幂等：第二次运行无命中', () => {
  const { root, now } = makeTree({ 'src/a.ts': HOUR_MS, 'pkg/tsconfig.tsbuildinfo': HOUR_MS })
  normalizeFutureMtimes(root, { now })
  const second = normalizeFutureMtimes(root, { now })
  assert.deepEqual(second, { removed: [], touched: [] })
})
