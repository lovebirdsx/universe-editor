#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Repository file / line-count observability.
 *
 *  Counts every git-tracked file and splits its lines into code / comment / blank, so the
 *  repo's size can be quoted in docs and PRs without reaching for cloc/tokei (neither is a
 *  dependency of this repo). Output is a set of terminal tables: by top-level directory, by
 *  extension, and the largest files.
 *
 *  Scope: `git ls-files` (tracked files only, so build output never leaks in). The two vendor
 *  submodules are excluded automatically — git lists them as gitlinks, not as files.
 *  Lockfiles are machine-generated and would swamp the headline number, so they are measured
 *  and reported in their own section instead of the main totals.
 *
 *  Caveat: this is an approximation, not a parser. Comment detection is prefix/state based
 *  and quote-aware, which handles real source well (a `'https://…'` literal is code, not a
 *  comment) but can still miscount pathological cases such as `//` inside a regex literal.
 *
 *  Usage:
 *    node scripts/bench/count-loc.mjs            # report
 *    node scripts/bench/count-loc.mjs --top 20   # show the 20 largest files
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process'
import { closeSync, lstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { basename, dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SNIFF_BYTES = 8000
const DEFAULT_TOP = 10

// 机器生成的锁文件：单独一节汇报，不进主表，否则「代码行」会被 vendor 里的 package-lock 带偏。
const GENERATED_FILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json'])
// SVG 是文本 XML 但不是代码：计入文件数，不计行数。
const ASSET_EXT = new Set(['svg'])

const SLASH_EXT = new Set(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'css'])
const HASH_EXT = new Set(['sh', 'bash', 'ps1', 'yaml', 'yml', 'ftl', 'properties', 'gitignore'])
const MARKUP_EXT = new Set(['html', 'htm', 'md', 'markdown', 'xml'])

// quotes 只对 slash 系列打开：只有 C 系语言普遍存在 `'…//…'` 这种字符串内含注释符的写法。
// yaml/markdown 里撇号满天飞，跟引号状态反而会误吞整行。
const SYNTAX = {
  slash: { line: '//', blockOpen: '/*', blockClose: '*/', quotes: true },
  hash: { line: '#', blockOpen: null, blockClose: null, quotes: false },
  markup: { line: null, blockOpen: '<!--', blockClose: '-->', quotes: false },
  none: { line: null, blockOpen: null, blockClose: null, quotes: false },
}

export function profileFor(ext) {
  if (SLASH_EXT.has(ext)) return 'slash'
  if (HASH_EXT.has(ext)) return 'hash'
  if (MARKUP_EXT.has(ext)) return 'markup'
  return 'none'
}

/** 文件相对路径 -> 统计用的扩展名标签。 */
export function extLabel(rel) {
  const ext = extname(rel).slice(1).toLowerCase()
  return ext === '' ? '(无扩展名)' : `.${ext}`
}

export function topDir(rel) {
  const i = rel.indexOf('/')
  return i === -1 ? '(仓库根目录)' : rel.slice(0, i)
}

/**
 * 剥掉注释跨度，返回剩余文本与「仍在块注释内」的续行状态。
 * 字符串字面量按原样保留：整行只有字符串也是代码。
 */
export function stripComments(line, state, syntax) {
  let out = ''
  let i = 0
  let quote = null
  let open = state
  while (i < line.length) {
    if (open !== null) {
      const end = line.indexOf(syntax.blockClose, i)
      if (end === -1) return { text: out, state: open }
      i = end + syntax.blockClose.length
      open = null
      continue
    }
    const ch = line[i]
    if (quote !== null) {
      out += ch
      if (ch === '\\') {
        out += line[i + 1] ?? ''
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (syntax.quotes && (ch === '"' || ch === "'" || ch === '`')) {
      quote = ch
      out += ch
      i += 1
      continue
    }
    if (syntax.line !== null && line.startsWith(syntax.line, i)) break
    if (syntax.blockOpen !== null && line.startsWith(syntax.blockOpen, i)) {
      open = syntax.blockOpen
      i += syntax.blockOpen.length
      continue
    }
    out += ch
    i += 1
  }
  return { text: out, state: open }
}

export function classifyLine(line, state, syntax) {
  if (line.trim() === '') return { kind: 'blank', state }
  const { text, state: next } = stripComments(line, state, syntax)
  return { kind: text.trim() === '' ? 'comment' : 'code', state: next }
}

export function tallyText(text, profile) {
  const syntax = SYNTAX[profile]
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  let state = null
  let code = 0
  let comment = 0
  let blank = 0
  for (const line of lines) {
    const result = classifyLine(line, state, syntax)
    state = result.state
    if (result.kind === 'blank') blank += 1
    else if (result.kind === 'comment') comment += 1
    else code += 1
  }
  return { lines: lines.length, code, comment, blank }
}

export function isBinaryFile(abs) {
  const fd = openSync(abs, 'r')
  try {
    const buf = Buffer.alloc(SNIFF_BYTES)
    const read = readSync(fd, buf, 0, SNIFF_BYTES, 0)
    return buf.subarray(0, read).includes(0)
  } finally {
    closeSync(fd)
  }
}

export function listTrackedFiles(root) {
  const raw = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  const all = raw.split('\0').filter((rel) => rel !== '')
  // submodule 在 index 里是 gitlink（statSync 出来是目录），只留真实文件即自动排除。
  const files = all.filter((rel) => {
    try {
      return lstatSync(resolve(root, rel)).isFile()
    } catch {
      return false
    }
  })
  return { files, rawCount: all.length }
}

const NO_LINES = { lines: 0, code: 0, comment: 0, blank: 0 }

export function measureFiles(root, rels) {
  const perFile = []
  for (const rel of rels) {
    const abs = resolve(root, rel)
    let bytes = 0
    try {
      bytes = statSync(abs).size
    } catch {
      continue
    }
    if (GENERATED_FILES.has(basename(rel))) {
      const profile = profileFor(extname(rel).slice(1).toLowerCase())
      perFile.push({
        rel,
        bytes,
        bucket: 'generated',
        ...tallyText(readFileSync(abs, 'utf8'), profile),
      })
      continue
    }
    if (ASSET_EXT.has(extname(rel).slice(1).toLowerCase())) {
      perFile.push({ rel, bytes, bucket: 'asset', ...NO_LINES })
      continue
    }
    if (isBinaryFile(abs)) {
      perFile.push({ rel, bytes, bucket: 'binary', ...NO_LINES })
      continue
    }
    const profile = profileFor(extname(rel).slice(1).toLowerCase())
    perFile.push({ rel, bytes, bucket: 'text', ...tallyText(readFileSync(abs, 'utf8'), profile) })
  }
  return perFile
}

const EMPTY_TOTALS = () => ({
  files: 0,
  textFiles: 0,
  lines: 0,
  code: 0,
  comment: 0,
  blank: 0,
  bytes: 0,
})

function accumulate(target, file) {
  target.files += 1
  target.bytes += file.bytes
  if (file.bucket === 'text') target.textFiles += 1
  target.lines += file.lines
  target.code += file.code
  target.comment += file.comment
  target.blank += file.blank
}

export function summarize(perFile) {
  const byDir = new Map()
  const byExt = new Map()
  const totals = EMPTY_TOTALS()
  const generated = []
  for (const file of perFile) {
    if (file.bucket === 'generated') {
      generated.push(file)
      continue
    }
    for (const [map, key] of [
      [byDir, topDir(file.rel)],
      [byExt, extLabel(file.rel)],
    ]) {
      if (!map.has(key)) map.set(key, EMPTY_TOTALS())
      accumulate(map.get(key), file)
    }
    accumulate(totals, file)
  }
  const rank = (map) => [...map.entries()].sort((a, b) => b[1].lines - a[1].lines)
  const skipped = { binary: EMPTY_TOTALS(), asset: EMPTY_TOTALS() }
  for (const file of perFile) {
    if (file.bucket === 'binary' || file.bucket === 'asset') accumulate(skipped[file.bucket], file)
  }
  return { byDir: rank(byDir), byExt: rank(byExt), totals, generated, skipped }
}

const WIDE_CHAR = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/

export function displayWidth(text) {
  let width = 0
  for (const ch of text) width += WIDE_CHAR.test(ch) ? 2 : 1
  return width
}

function padEnd(text, width) {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)))
}

function padStart(text, width) {
  return ' '.repeat(Math.max(0, width - displayWidth(text))) + text
}

export function renderTable(headers, rows, rightAligned = []) {
  const widths = headers.map((header, i) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(String(row[i] ?? '')))),
  )
  const render = (cells) =>
    cells
      .map((cell, i) => {
        const text = String(cell ?? '')
        return rightAligned.includes(i) ? padStart(text, widths[i]) : padEnd(text, widths[i])
      })
      .join('  ')
      .trimEnd()
  return [render(headers), ...rows.map(render)]
}

const num = (value) => value.toLocaleString('en-US')

function totalsRow(label, totals) {
  return [
    label,
    num(totals.files),
    num(totals.textFiles),
    num(totals.lines),
    num(totals.code),
    num(totals.comment),
    num(totals.blank),
  ]
}

const tableHeaders = (first) => [first, '文件', '文本', '总行', '代码', '注释', '空行']
const TABLE_RIGHT = [1, 2, 3, 4, 5, 6]

export function formatReport(summary, perFile, topN, topDirs = 15) {
  const out = []
  out.push('[loc] 仓库文件与行数统计（数据源：git ls-files）')
  out.push('')
  out.push('按顶层目录')
  const dirRows = summary.byDir.slice(0, topDirs).map(([name, t]) => totalsRow(name, t))
  dirRows.push(totalsRow('合计', summary.totals))
  out.push(...renderTable(tableHeaders('目录'), dirRows, TABLE_RIGHT))

  out.push('')
  const extShown = Math.min(15, summary.byExt.length)
  out.push(`按扩展名（行数前 ${extShown} / 共 ${summary.byExt.length} 种）`)
  out.push(
    ...renderTable(
      tableHeaders('扩展名'),
      summary.byExt.slice(0, 15).map(([name, t]) => totalsRow(name, t)),
      TABLE_RIGHT,
    ),
  )

  const largest = perFile
    .filter((file) => file.bucket === 'text')
    .sort((a, b) => b.lines - a.lines)
    .slice(0, topN)
  if (largest.length > 0) {
    out.push('')
    out.push(`最大的 ${largest.length} 个文件（按行数）`)
    out.push(
      ...renderTable(
        ['行数', '文件'],
        largest.map((f) => [num(f.lines), f.rel]),
        [0],
      ),
    )
  }

  const { skipped, generated } = summary
  const { binary, asset } = skipped
  out.push('')
  const kb = (bytes) => `${(bytes / 1024).toFixed(0)} kB`
  out.push(
    `[loc] 计入文件数但不计行数：二进制 ${num(binary.files)} 个（${kb(binary.bytes)}）、` +
      `资源 ${num(asset.files)} 个（${kb(asset.bytes)}）`,
  )
  if (generated.length > 0) {
    const generatedLines = generated.reduce((sum, f) => sum + f.lines, 0)
    out.push(
      `[loc] 生成物（锁文件）${generated.length} 个、${num(generatedLines)} 行，未计入上表：` +
        generated.map((f) => f.rel).join('、'),
    )
  }
  return out.join('\n')
}

function parseTop(argv) {
  const i = argv.indexOf('--top')
  if (i === -1) return DEFAULT_TOP
  const value = Number(argv[i + 1])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_TOP
}

function main() {
  const topN = parseTop(process.argv.slice(2))
  const { files, rawCount } = listTrackedFiles(REPO_ROOT)
  if (files.length === 0) {
    console.error(`[loc] 未在 ${REPO_ROOT} 找到 git 跟踪文件——是否不在仓库内？`)
    process.exit(1)
  }
  const perFile = measureFiles(REPO_ROOT, files)
  console.log(formatReport(summarize(perFile), perFile, topN))
  const gitlinks = rawCount - files.length
  console.log(
    `[loc] git ls-files 共 ${num(rawCount)} 条` +
      (gitlinks > 0 ? `，跳过 ${gitlinks} 个子模块 gitlink` : '') +
      `，统计 ${num(files.length)} 个文件`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
