/*---------------------------------------------------------------------------------------------
 *  Tests for scripts/check-builtin-extensions-engines.mjs. Run with `node --test`.
 *  覆盖：期望表达式计算、校验/修复逻辑、幂等、以及 fix 不改动 manifest 其余格式
 *  （单行紧凑数组保持不变，避免全量重序列化的噪音）。
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkBuiltinExtensionsEngines,
  computeExpectedEngine,
  patchEnginesUniverse,
} from '../check-builtin-extensions-engines.mjs'

test('computeExpectedEngine 取 major.minor、patch 固定 0', () => {
  assert.equal(computeExpectedEngine('0.13.0'), '^0.13.0')
  assert.equal(computeExpectedEngine('0.13.5'), '^0.13.0')
  assert.equal(computeExpectedEngine('1.2.3'), '^1.2.0')
})

test('computeExpectedEngine 拒绝非 X.Y.Z', () => {
  assert.throws(() => computeExpectedEngine('0.13'), /X\.Y\.Z/)
  assert.throws(() => computeExpectedEngine('v0.13.0'), /X\.Y\.Z/)
})

/** 构造一个含 App 版本 + 三个内置插件的最小仓库夹具。 */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'builtin-engines-'))
  mkdirSync(join(root, 'apps/editor'), { recursive: true })
  writeFileSync(join(root, 'apps/editor/package.json'), JSON.stringify({ version: '0.13.0' }) + '\n')
  const extensions = join(root, 'extensions')
  mkdirSync(join(extensions, 'foo'), { recursive: true })
  mkdirSync(join(extensions, 'bar'), { recursive: true })
  mkdirSync(join(extensions, 'no-manifest'), { recursive: true })
  // foo 用单行紧凑数组 + 旧版本区间，验证 fix 不改动其余格式
  writeFileSync(
    join(extensions, 'foo/package.json'),
    [
      '{',
      '  "name": "@universe-editor/foo",',
      '  "engines": {',
      '    "universe": ">=0.1.0 <1.0.0"',
      '  },',
      '  "contributes": { "commands": [ { "command": "a", "title": "b" } ] }',
      '}',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(extensions, 'bar/package.json'),
    JSON.stringify({ name: '@universe-editor/bar', engines: { universe: '^0.13.0' } }, null, 2) +
      '\n',
  )
  return root
}

test('check 模式：报告不符项、跳过无 package.json 的目录', () => {
  const root = makeFixture()
  const { expected, mismatches, updated } = checkBuiltinExtensionsEngines({ repoRoot: root })
  assert.equal(expected, '^0.13.0')
  assert.deepEqual(mismatches, [{ rel: 'extensions/foo', found: '>=0.1.0 <1.0.0' }])
  assert.deepEqual(updated, [])
  // 未写盘
  assert.match(readFileSync(join(root, 'extensions/foo/package.json'), 'utf8'), />=0\.1\.0 <1\.0\.0/)
})

test('fix 模式：原地改写并保留单行紧凑数组', () => {
  const root = makeFixture()
  const { mismatches, updated } = checkBuiltinExtensionsEngines({ repoRoot: root, fix: true })
  assert.deepEqual(mismatches, [{ rel: 'extensions/foo', found: '>=0.1.0 <1.0.0' }])
  assert.deepEqual(updated, ['extensions/foo'])
  const text = readFileSync(join(root, 'extensions/foo/package.json'), 'utf8')
  assert.match(text, /"universe": "\^0\.13\.0"/)
  // 紧凑数组仍保持单行
  assert.match(text, /"contributes": \{ "commands": \[ \{ "command": "a", "title": "b" \} \] \}/)
})

test('fix 幂等：第二次无变化不写盘', () => {
  const root = makeFixture()
  checkBuiltinExtensionsEngines({ repoRoot: root, fix: true })
  assert.deepEqual(checkBuiltinExtensionsEngines({ repoRoot: root, fix: true }).updated, [])
  assert.deepEqual(checkBuiltinExtensionsEngines({ repoRoot: root }).mismatches, [])
})

test('patchEnginesUniverse 无 universe 键时注入', () => {
  const content = '{ "engines": {} }'
  const out = patchEnginesUniverse(content, '^0.13.0')
  assert.deepEqual(JSON.parse(out).engines, { universe: '^0.13.0' })
})
