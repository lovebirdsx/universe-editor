/*---------------------------------------------------------------------------------------------
 *  Tests for scripts/check-claude-md-size.mjs. Run with `node --test`.
 *  覆盖：递归收集（含 vendor 一层下沉、跳过 node_modules/.git/dist/out/.turbo）、
 *  阈值判定、豁免名单、排序。
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkClaudeMdSize } from '../check-claude-md-size.mjs'

function makeRepo() {
  return mkdtempSync(join(tmpdir(), 'claude-md-size-'))
}

function writeClaudeMd(root, rel, bytes) {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, 'x'.repeat(bytes))
}

test('全部在预算内：oversize 为空、total 正确', () => {
  const root = makeRepo()
  writeClaudeMd(root, 'CLAUDE.md', 1000)
  writeClaudeMd(root, 'packages/foo/CLAUDE.md', 2000)
  const { total, oversize } = checkClaudeMdSize({ repoRoot: root })
  assert.equal(total, 2)
  assert.deepEqual(oversize, [])
})

test('超过阈值被列出，且按大小降序', () => {
  const root = makeRepo()
  writeClaudeMd(root, 'CLAUDE.md', 16_000)
  writeClaudeMd(root, 'packages/big/CLAUDE.md', 20_000)
  writeClaudeMd(root, 'packages/ok/CLAUDE.md', 1_000)
  const { oversize } = checkClaudeMdSize({ repoRoot: root })
  assert.equal(oversize.length, 2)
  assert.equal(oversize[0].file, 'packages/big/CLAUDE.md')
  assert.equal(oversize[0].size, 20_000)
  assert.equal(oversize[1].file, 'CLAUDE.md')
})

test('恰好等于阈值不超标（边界 > 而非 >=）', () => {
  const root = makeRepo()
  writeClaudeMd(root, 'CLAUDE.md', 15_000)
  const { oversize } = checkClaudeMdSize({ repoRoot: root })
  assert.deepEqual(oversize, [])
})

test('豁免名单内文件即使超标也不列出', () => {
  const root = makeRepo()
  writeClaudeMd(root, 'extensions/perforce/CLAUDE.md', 100_000)
  const { oversize } = checkClaudeMdSize({ repoRoot: root })
  assert.deepEqual(oversize, [])
})

test('跳过 node_modules/.git/dist/out/.turbo', () => {
  const root = makeRepo()
  for (const dir of ['node_modules/dep', '.git', 'dist', 'out', '.turbo']) {
    writeClaudeMd(root, `${dir}/CLAUDE.md`, 100_000)
  }
  writeClaudeMd(root, 'packages/foo/CLAUDE.md', 1_000)
  const { total, oversize } = checkClaudeMdSize({ repoRoot: root })
  assert.equal(total, 1)
  assert.deepEqual(oversize, [])
})

test('vendor 只下沉一层收根部 CLAUDE.md，不递归内部', () => {
  const root = makeRepo()
  writeClaudeMd(root, 'vendor/fork-a/CLAUDE.md', 1_000)
  writeClaudeMd(root, 'vendor/fork-a/deep/nested/CLAUDE.md', 100_000)
  const { total, oversize } = checkClaudeMdSize({ repoRoot: root })
  assert.equal(total, 1)
  assert.deepEqual(oversize, [])
})

test('自定义 maxBytes 生效', () => {
  const root = makeRepo()
  writeClaudeMd(root, 'CLAUDE.md', 500)
  const { oversize } = checkClaudeMdSize({ repoRoot: root, maxBytes: 100 })
  assert.equal(oversize.length, 1)
})
