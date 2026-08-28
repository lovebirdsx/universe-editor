/*---------------------------------------------------------------------------------------------
 *  Tests for scripts/check-sensitive-strings.mjs. Run with `node --test`.
 *  覆盖：规则加载四态（missing/empty/parse-error/ok）、--check 的退出码、掩码输出、
 *  allow/allowMatch/sensitive-strings:allow 三级豁免、compileRule 结构映射。
 *  只打纯函数，绝不触发 process.exit（这是纯函数化的意义）。
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  checkSensitiveStrings,
  collectFiles,
  compileRule,
  formatGroupHeader,
  formatHit,
  maskMatch,
} from '../check-sensitive-strings.mjs'

function makeRepo() {
  return mkdtempSync(join(tmpdir(), 'sensitive-strings-'))
}

function writeConfig(root, content) {
  const path = join(root, 'sensitive-rules.json')
  writeFileSync(path, content)
  return path
}

function writeSource(root, rel, content) {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

test('缺失规则文件 + --check 视为失败（核心回归）', () => {
  const root = makeRepo()
  const result = checkSensitiveStrings({
    repoRoot: root,
    configPath: join(root, 'nope.json'),
    check: true,
  })
  assert.equal(result.status, 'missing')
  assert.equal(result.exit, 1)
})

test('缺失规则文件 + 默认模式为 report-only（exit 0）', () => {
  const root = makeRepo()
  const result = checkSensitiveStrings({ repoRoot: root, configPath: join(root, 'nope.json') })
  assert.equal(result.status, 'missing')
  assert.equal(result.exit, 0)
})

test('缺失规则文件 + allowMissing 逃生阀降级为 warn', () => {
  const root = makeRepo()
  const result = checkSensitiveStrings({
    repoRoot: root,
    configPath: join(root, 'nope.json'),
    check: true,
    allowMissing: true,
  })
  assert.equal(result.status, 'missing-allowed')
  assert.equal(result.exit, 0)
})

test('非法 JSON + --check 失败且 error 不含原文片段', () => {
  const root = makeRepo()
  const configPath = writeConfig(root, '{ "bad-json-probe" bad json')
  const result = checkSensitiveStrings({ repoRoot: root, configPath, check: true })
  assert.equal(result.status, 'parse-error')
  assert.equal(result.exit, 1)
  assert.ok(result.error)
  assert.ok(!result.error.includes('bad-json-probe'))
})

test('顶层非数组 + --check 视为 parse-error', () => {
  const root = makeRepo()
  const configPath = writeConfig(root, '{"id":"x"}')
  const result = checkSensitiveStrings({ repoRoot: root, configPath, check: true })
  assert.equal(result.status, 'parse-error')
  assert.equal(result.exit, 1)
})

test('0 条规则 + --check 视为 empty 失败', () => {
  const root = makeRepo()
  const configPath = writeConfig(root, '[]')
  const result = checkSensitiveStrings({ repoRoot: root, configPath, check: true })
  assert.equal(result.status, 'empty')
  assert.equal(result.exit, 1)
})

test('正常命中：exit=1 且 file/line/match 正确', () => {
  const root = makeRepo()
  const configPath = writeConfig(
    root,
    JSON.stringify([
      { id: 'probe', desc: 'probe rule', pattern: 'leak\\.example\\.com', flags: 'gi' },
    ]),
  )
  writeSource(root, 'src/a.ts', 'const u = "https://leak.example.com"\n')
  const result = checkSensitiveStrings({ repoRoot: root, configPath, check: true })
  assert.equal(result.status, 'ok')
  assert.equal(result.exit, 1)
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].file, 'src/a.ts')
  assert.equal(result.findings[0].line, 1)
  assert.equal(result.findings[0].match, 'leak.example.com')
})

test('无命中：exit=0 且 ruleCount 正确回传', () => {
  const root = makeRepo()
  const configPath = writeConfig(
    root,
    JSON.stringify([
      { id: 'a', desc: 'a', pattern: 'never-match-1', flags: 'gi' },
      { id: 'b', desc: 'b', pattern: 'never-match-2', flags: 'gi' },
    ]),
  )
  writeSource(root, 'src/a.ts', 'nothing here\n')
  const result = checkSensitiveStrings({ repoRoot: root, configPath, check: true })
  assert.equal(result.status, 'ok')
  assert.equal(result.exit, 0)
  assert.equal(result.ruleCount, 2)
  assert.deepEqual(result.findings, [])
})

test('maskMatch：不含原文、不泄露长度、全量 hex sha、确定性', () => {
  const masked = maskMatch('leak.example.com')
  assert.ok(!masked.includes('leak.example.com'))
  assert.match(masked, /^sha=[0-9a-f]{64}$/)
  assert.ok(!masked.includes('len='))
  assert.equal(maskMatch('leak.example.com'), masked)
  assert.notEqual(maskMatch('other.example.com'), masked)
})

test('formatHit(mask=true)：不输出 match 但含 file:line', () => {
  const hit = { line: 3, match: 'leak.example.com' }
  const out = formatHit('src/a.ts', hit, true)
  assert.ok(!out.includes('leak.example.com'))
  assert.ok(out.includes('src/a.ts:3'))
})

test('formatGroupHeader(mask=true)：不输出 desc 但含 id', () => {
  const items = [
    { rule: { id: 'probe', desc: 'sensitive-desc-value' } },
    { rule: { id: 'probe', desc: 'x' } },
  ]
  const out = formatGroupHeader('probe', items, true)
  assert.ok(out.includes('probe'))
  assert.ok(!out.includes('sensitive-desc-value'))
  assert.ok(out.includes('2'))
})

test('sensitive-strings:allow 整行豁免', () => {
  const root = makeRepo()
  const configPath = writeConfig(
    root,
    JSON.stringify([
      { id: 'probe', desc: 'probe rule', pattern: 'leak\\.example\\.com', flags: 'gi' },
    ]),
  )
  writeSource(root, 'src/a.ts', 'const u = "https://leak.example.com" // sensitive-strings:allow\n')
  const result = checkSensitiveStrings({ repoRoot: root, configPath, check: true })
  assert.equal(result.exit, 0)
  assert.deepEqual(result.findings, [])
})

test('allow 整行豁免（行内含占位 IP 则整行放过）', () => {
  const root = makeRepo()
  const configPath = writeConfig(
    root,
    JSON.stringify([
      {
        id: 'probe',
        desc: 'probe rule',
        pattern: 'fakehost\\.example\\.com',
        flags: 'gi',
        allow: [{ pattern: '192\\.0\\.2\\.' }],
      },
    ]),
  )
  writeSource(root, 'src/a.ts', 'const ip = "192.0.2.1"; const h = "fakehost.example.com"\n')
  const result = checkSensitiveStrings({ repoRoot: root, configPath, check: true })
  assert.equal(result.exit, 0)
  assert.deepEqual(result.findings, [])
})

test('allowMatch 只豁免命中片段', () => {
  const root = makeRepo()
  const configPath = writeConfig(
    root,
    JSON.stringify([
      {
        id: 'probe',
        desc: 'probe rule',
        pattern: 'gallery\\.example\\.com|fakehost\\.example\\.com',
        flags: 'gi',
        allowMatch: [{ pattern: 'gallery\\.example\\.com' }],
      },
    ]),
  )
  writeSource(root, 'src/a.ts', 'gallery.example.com fakehost.example.com\n')
  const result = checkSensitiveStrings({ repoRoot: root, configPath, check: true })
  assert.equal(result.exit, 1)
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].match, 'fakehost.example.com')
})

test('compileRule：JSON 规则映射为运行时正则结构', () => {
  const rule = compileRule({
    id: 'probe',
    desc: 'probe rule',
    pattern: 'leak\\.example\\.com',
    flags: 'gi',
    allow: [{ pattern: '192\\.0\\.2\\.' }],
    allowMatch: [{ pattern: 'example\\.com' }],
  })
  assert.equal(rule.id, 'probe')
  assert.equal(rule.desc, 'probe rule')
  assert.ok(rule.re instanceof RegExp)
  assert.equal(rule.re.flags, 'gi')
  assert.ok(rule.re.test('leak.example.com'))
  assert.ok(rule.allow[0] instanceof RegExp)
  assert.ok(rule.allow[0].test('192.0.2.1'))
  assert.ok(rule.allowMatch[0] instanceof RegExp)
  assert.ok(rule.allowMatch[0].test('gallery.example.com'))

  const bare = compileRule({ id: 'x', desc: 'y', pattern: 'z' })
  assert.equal(bare.allow, undefined)
  assert.equal(bare.allowMatch, undefined)
  assert.equal(bare.re.flags, 'gi')
})

test('compileRule：主 pattern 强制带 g（否则 matchAll 抛 TypeError）', () => {
  const rule = compileRule({ id: 'x', desc: 'y', pattern: 'leak', flags: 'i' })
  assert.ok(rule.re.flags.includes('g'))
  assert.doesNotThrow(() => [...'leak leak'.matchAll(rule.re)])
})

test('compileRule：allow/allowMatch 剥掉 g（否则 lastIndex 推进使豁免时真时假）', () => {
  const rule = compileRule({
    id: 'x',
    desc: 'y',
    pattern: 'leak',
    allow: [{ pattern: 'ok', flags: 'gi' }],
    allowMatch: [{ pattern: 'ok', flags: 'g' }],
  })
  assert.ok(!rule.allow[0].flags.includes('g'))
  assert.ok(!rule.allowMatch[0].flags.includes('g'))
  // 同一 pattern 反复 test 同一内容必须恒定
  assert.equal(rule.allow[0].test('ok'), rule.allow[0].test('ok'))
  assert.equal(rule.allowMatch[0].test('ok'), rule.allowMatch[0].test('ok'))
})

test('allow 带 g 时豁免仍对每一行稳定生效', () => {
  const root = makeRepo()
  const configPath = writeConfig(
    root,
    JSON.stringify([
      {
        id: 'probe',
        desc: 'probe rule',
        pattern: 'leak\\.example\\.com',
        flags: 'gi',
        allow: [{ pattern: '192\\.0\\.2\\.', flags: 'g' }],
      },
    ]),
  )
  const line = 'const x = "leak.example.com" // 192.0.2.1\n'
  writeSource(root, 'src/a.ts', line.repeat(4))
  const result = checkSensitiveStrings({ repoRoot: root, configPath, check: true })
  assert.equal(result.exit, 0)
  assert.deepEqual(result.findings, [])
})

test('scanFile：超长行跳过（疑似 base64 / 压缩产物）', () => {
  const root = makeRepo()
  const configPath = writeConfig(
    root,
    JSON.stringify([{ id: 'probe', desc: 'probe rule', pattern: 'leak\\.example\\.com' }]),
  )
  writeSource(root, 'src/short.ts', 'leak.example.com\n')
  writeSource(root, 'src/long.ts', `${'x'.repeat(2001)}leak.example.com\n`)
  const result = checkSensitiveStrings({ repoRoot: root, configPath, check: true })
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].file, 'src/short.ts')
})

test('collectFiles：SCAN_NAMES 收无扩展名文件、SKIP_FILES/SKIP_DIRS 跳过', () => {
  const root = makeRepo()
  writeSource(root, '.gitmodules', 'x\n')
  writeSource(root, '.npmrc', 'x\n')
  writeSource(root, 'src/a.ts', 'x\n')
  writeSource(root, 'sensitive-rules.json', '[]\n')
  writeSource(root, 'sensitive-rules.example.json', '[]\n')
  writeSource(root, 'pnpm-lock.yaml', 'x\n')
  writeSource(root, 'src/a.png', 'x\n')
  writeSource(root, 'node_modules/dep/index.js', 'x\n')
  writeSource(root, 'vendor/fork/index.ts', 'x\n')

  const names = collectFiles(root).map((f) => f.slice(root.length + 1).replace(/\\/g, '/'))
  assert.deepEqual(names.sort(), ['.gitmodules', '.npmrc', 'src/a.ts'])
})
