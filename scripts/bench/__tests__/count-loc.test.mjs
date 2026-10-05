/*---------------------------------------------------------------------------------------------
 *  scripts/bench/count-loc.mjs 单测：行分类状态机 / 二进制嗅探 / 聚合分流 / 表格渲染。
 *
 *  分类器的引号保护是重点：`'https://example.com'` 必须算代码而不是注释，这是本仓库
 *  TS 源码里最常见的误判来源。样本文件全部落在临时目录，不依赖真实仓库内容。
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  classifyLine,
  displayWidth,
  extLabel,
  formatReport,
  isBinaryFile,
  measureFiles,
  profileFor,
  renderTable,
  stripComments,
  summarize,
  tallyText,
  topDir,
} from '../count-loc.mjs'
import { mkTempDir } from '../../lib/temp-root.mjs'

const slash = { line: '//', blockOpen: '/*', blockClose: '*/', quotes: true }
const markup = { line: null, blockOpen: '<!--', blockClose: '-->', quotes: false }
const hash = { line: '#', blockOpen: null, blockClose: null, quotes: false }

/** 逐行跑分类器，返回 kind 序列（块注释状态跨行传递）。 */
function kinds(lines, syntax) {
  let state = null
  const out = []
  for (const line of lines) {
    const result = classifyLine(line, state, syntax)
    state = result.state
    out.push(result.kind)
  }
  return out
}

test('profileFor：扩展名映射到注释语法', () => {
  assert.equal(profileFor('tsx'), 'slash')
  assert.equal(profileFor('mjs'), 'slash')
  assert.equal(profileFor('css'), 'slash')
  assert.equal(profileFor('yml'), 'hash')
  assert.equal(profileFor('md'), 'markup')
  assert.equal(profileFor('json'), 'none')
  assert.equal(profileFor(''), 'none')
})

test('classifyLine：代码 / 行注释 / 块注释 / 空行', () => {
  assert.deepEqual(kinds(['const a = 1', '', '   ', '// hi', 'code // trailing'], slash), [
    'code',
    'blank',
    'blank',
    'comment',
    'code',
  ])
})

test("classifyLine：字符串里的 // 不算注释（'https://…'）", () => {
  assert.deepEqual(
    kinds(
      [
        "const url = 'https://example.com/a'",
        'const a = 1 // real comment',
        'const s = "a//b"',
        'const t = `x // y`',
      ],
      slash,
    ),
    ['code', 'code', 'code', 'code'],
  )
})

test('classifyLine：块注释同行闭合与跨行续行', () => {
  assert.deepEqual(
    kinds(['/* one line */', '/* open', '  still inside', 'closed */ const x = 1', 'after'], slash),
    ['comment', 'comment', 'comment', 'code', 'code'],
  )
})

test('stripComments：整行注释返回空文本，代码行保留内容', () => {
  assert.equal(stripComments('// gone', null, slash).text.trim(), '')
  assert.equal(stripComments('a /* mid */ b', null, slash).text.trim(), 'a  b')
  assert.equal(stripComments('/* open', null, slash).state, '/*')
  assert.equal(stripComments('close */ tail', '/*', slash).state, null)
})

test('classifyLine：markdown 的 <!-- --> 注释', () => {
  assert.deepEqual(kinds(['<!-- hidden -->', 'visible text', '', '<!-- open', 'end -->'], markup), [
    'comment',
    'code',
    'blank',
    'comment',
    'comment',
  ])
})

test('classifyLine：yaml/shell 的 # 注释', () => {
  assert.deepEqual(kinds(['# comment', 'key: value', '  # indented'], hash), [
    'comment',
    'code',
    'comment',
  ])
})

test('tallyText：结尾换行不产生伪空行', () => {
  const withNewline = tallyText('a\n\nb\n', 'none')
  const withoutNewline = tallyText('a\n\nb', 'none')
  assert.deepEqual(withNewline, { lines: 3, code: 2, comment: 0, blank: 1 })
  assert.deepEqual(withoutNewline, withNewline)
  assert.deepEqual(tallyText('', 'none'), { lines: 0, code: 0, comment: 0, blank: 0 })
})

test('isBinaryFile：含 NUL 字节判为二进制，纯文本判为文本', () => {
  const dir = mkTempDir('ue-loc-test-')
  try {
    const binary = join(dir, 'a.bin')
    writeFileSync(binary, Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47]))
    const text = join(dir, 'a.ts')
    writeFileSync(text, 'export const a = 1\n')
    assert.equal(isBinaryFile(binary), true)
    assert.equal(isBinaryFile(text), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('measureFiles：文本 / 二进制 / 资源 / 锁文件 正确分流', () => {
  const dir = mkTempDir('ue-loc-test-')
  try {
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.ts'), 'const a = 1\n\n// c\n')
    writeFileSync(join(dir, 'logo.svg'), '<svg>\n<rect />\n</svg>\n')
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([1, 2, 0, 3]))
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n'.repeat(5))
    const perFile = measureFiles(dir, ['src/a.ts', 'logo.svg', 'blob.bin', 'pnpm-lock.yaml'])
    const byRel = new Map(perFile.map((f) => [f.rel, f]))
    assert.deepEqual(
      {
        bucket: byRel.get('src/a.ts').bucket,
        code: byRel.get('src/a.ts').code,
        comment: byRel.get('src/a.ts').comment,
        blank: byRel.get('src/a.ts').blank,
      },
      { bucket: 'text', code: 1, comment: 1, blank: 1 },
    )
    assert.equal(byRel.get('logo.svg').bucket, 'asset')
    assert.equal(byRel.get('logo.svg').lines, 0)
    assert.equal(byRel.get('blob.bin').bucket, 'binary')
    assert.equal(byRel.get('pnpm-lock.yaml').bucket, 'generated')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('measureFiles：路径不存在时跳过而非抛错', () => {
  const dir = mkTempDir('ue-loc-test-')
  try {
    assert.deepEqual(measureFiles(dir, ['missing.ts']), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('summarize：按目录与扩展名聚合，锁文件不进主表', () => {
  const perFile = [
    { rel: 'apps/editor/a.ts', bytes: 1, bucket: 'text', lines: 10, code: 8, comment: 1, blank: 1 },
    { rel: 'apps/editor/b.ts', bytes: 1, bucket: 'text', lines: 5, code: 5, comment: 0, blank: 0 },
    {
      rel: 'packages/platform/c.ts',
      bytes: 1,
      bucket: 'text',
      lines: 3,
      code: 3,
      comment: 0,
      blank: 0,
    },
    {
      rel: 'apps/editor/logo.svg',
      bytes: 1,
      bucket: 'asset',
      lines: 0,
      code: 0,
      comment: 0,
      blank: 0,
    },
    {
      rel: 'apps/editor/blob.bin',
      bytes: 1,
      bucket: 'binary',
      lines: 0,
      code: 0,
      comment: 0,
      blank: 0,
    },
    {
      rel: 'pnpm-lock.yaml',
      bytes: 1,
      bucket: 'generated',
      lines: 99,
      code: 99,
      comment: 0,
      blank: 0,
    },
  ]
  const summary = summarize(perFile)
  assert.equal(summary.totals.files, 5)
  assert.equal(summary.totals.textFiles, 3)
  assert.equal(summary.totals.lines, 18)
  assert.equal(summary.generated.length, 1)
  assert.equal(summary.skipped.binary.files, 1)
  assert.equal(summary.skipped.asset.files, 1)
  const dirs = new Map(summary.byDir)
  assert.equal(dirs.get('apps').lines, 15)
  assert.equal(dirs.get('apps').files, 4)
  assert.equal(dirs.get('packages').lines, 3)
  assert.deepEqual(summary.byExt[0][0], '.ts')
  assert.equal(summary.byExt[0][1].lines, 18)
})

test('summarize：根目录散文件归入 (仓库根目录)，无扩展名单列', () => {
  const perFile = [
    { rel: 'README.md', bytes: 1, bucket: 'text', lines: 4, code: 4, comment: 0, blank: 0 },
    { rel: 'LICENSE', bytes: 1, bucket: 'text', lines: 2, code: 2, comment: 0, blank: 0 },
  ]
  const summary = summarize(perFile)
  assert.equal(summary.byDir[0][0], '(仓库根目录)')
  assert.equal(topDir('README.md'), '(仓库根目录)')
  assert.equal(topDir('a/b/c.ts'), 'a')
  assert.ok(summary.byExt.some(([name]) => name === '(无扩展名)'))
  assert.equal(extLabel('LICENSE'), '(无扩展名)')
})

test('renderTable：按显示宽度对齐，CJK 表头不破格', () => {
  const lines = renderTable(['', '文件', '总行'], [['apps', '1,234', '9']], [1, 2])
  assert.equal(lines.length, 2)
  assert.equal(new Set(lines.map(displayWidth)).size, 1)
  assert.equal(displayWidth('中文'), 4)
  assert.equal(displayWidth('ab'), 2)
})

test('formatReport：包含三段表格与两项说明', () => {
  const perFile = [
    {
      rel: 'apps/editor/a.ts',
      bytes: 2048,
      bucket: 'text',
      lines: 10,
      code: 9,
      comment: 1,
      blank: 0,
    },
    {
      rel: 'apps/editor/logo.svg',
      bytes: 1024,
      bucket: 'asset',
      lines: 0,
      code: 0,
      comment: 0,
      blank: 0,
    },
    {
      rel: 'apps/editor/blob.bin',
      bytes: 512,
      bucket: 'binary',
      lines: 0,
      code: 0,
      comment: 0,
      blank: 0,
    },
    {
      rel: 'pnpm-lock.yaml',
      bytes: 4096,
      bucket: 'generated',
      lines: 99,
      code: 99,
      comment: 0,
      blank: 0,
    },
  ]
  const report = formatReport(summarize(perFile), perFile, 5)
  assert.match(report, /按顶层目录/)
  assert.match(report, /按扩展名/)
  assert.match(report, /最大的 1 个文件/)
  assert.match(report, /二进制 1 个/)
  assert.match(report, /资源 1 个/)
  assert.match(report, /生成物（锁文件）1 个、99 行/)
  // 合计只含 3 个非生成物文件（a.ts + svg + bin），锁文件的 99 行不进主表。
  assert.match(report, /\n合计\s+3\s+1\s+10\s+9\s+1\s+0/)
})
