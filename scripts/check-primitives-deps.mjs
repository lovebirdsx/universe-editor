#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  check-primitives-deps.mjs — 守护 packages/primitives 的「零依赖」不变量。
 *
 *  packages/primitives 要同时被内核（renderer，无 node API）与插件宿主消费，所以它不得
 *  import node 内置模块、electron、或任何其它 workspace 包——这是它作为「两端共同消费的
 *  稳定核心」的前提，破一次就不成立。包名取宽（primitives 而非 uri）本来就会招来
 *  「顺手塞点别的」的诱惑，护栏必须是机械的，否则它会退化成抽屉。
 *
 *  ESLint 的 no-restricted-imports 表达不了裸内置模块名（fs/path/os…）全集，也看不到
 *  package.json 的 dependencies，所以这条不变量在这里兜底（裸 node 脚本无构建依赖，也
 *  不占用 linter 的注意力）。确有无害巧合时在该行加 `primitives-allow` 注释豁免。
 *
 *  已知边界：扫描器不解析正则字面量，正则里的 `/*` 或引号会让注释/引号状态误判——
 *  这类误判若吞到文件末尾会被 `unterminated` 检出并报错，但若恰好在文件中间配上对
 *  仍可能漏扫一段。威胁模型是「无意的漂移」，不是「刻意绕过」。
 *
 *  Usage:
 *    node scripts/check-primitives-deps.mjs           # 报告，退出码 0
 *    node scripts/check-primitives-deps.mjs --check   # CI: 命中即退出 1
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHECK_ONLY = process.argv.slice(2).includes('--check')

const PRIMITIVES_DIR = 'packages/primitives'
const SELF_PACKAGE = '@universe-editor/primitives'
const ALLOW_MARKER = 'primitives-allow'

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage'])
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx)$/

// 裸内置名取根段（`fs/promises` → `fs`、`node:path/posix` → `path`）。
const BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, '').split('/')[0]))

// `import ... from 'x'` / `export ... from 'x'` / `import 'x'` / `import('x')` / `require('x')`。
// 在**整份文本**上跑（说明符可以换行：`import { a } from\n  'node:fs'`），行号由
// 匹配偏移换算。两道收窄：说明符本身不许跨行（`[^'"\n]+`），关键字前不许是 `.`
// 或词字符——否则「句尾属性访问 `obj.from` + 下一行字符串语句」会被当成模块说明符。
const SPECIFIER_RES = [
  /(?<![.\w$])from\s*['"]([^'"\n]+)['"]/g,
  /(?<![.\w$])import\s*\(\s*['"]([^'"\n]+)['"]/g,
  /(?<![.\w$])import\s+['"]([^'"\n]+)['"]/g,
  /(?<![.\w$])require\s*\(\s*['"]([^'"\n]+)['"]/g,
]

/**
 * 只剥注释、保留字符串字面量（模块说明符本身就是字符串），并在块注释里逐字补回换行，
 * 这样**换行数**与原文一致 → 行号可由剥注释后的偏移换算。
 *
 * 只跟踪引号/注释状态，不解析正则字面量：正则里的 `/*` 会把扫描器带进块注释状态。
 * 这种误判原来是静默的（该文件余下部分不再被扫描，护栏假绿），所以退出时自检
 * 未闭合状态并返回 `unterminated`，让调用方报错而不是放行。
 */
function stripComments(text) {
  let out = ''
  let quote
  let unterminated
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (quote !== undefined) {
      out += ch
      if (ch === '\\') {
        out += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (ch === quote) quote = undefined
      i++
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ch
      i++
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      let closed = false
      while (i < text.length) {
        if (text[i] === '*' && text[i + 1] === '/') {
          closed = true
          i += 2
          break
        }
        if (text[i] === '\n') out += '\n'
        i++
      }
      if (!closed) {
        unterminated = '块注释未闭合（疑为正则字面量里的 `/*`，扫描不可信）'
        break
      }
      continue
    }
    out += ch
    i++
  }
  if (unterminated === undefined && quote !== undefined) {
    unterminated = `未闭合的 ${quote} 引号（疑为正则字面量里的引号，扫描不可信）`
  }
  return { text: out, unterminated }
}

/** 剥注释后文本里每个换行的偏移，用于把匹配偏移换算成行号。 */
function newlineOffsets(text) {
  const offsets = []
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) offsets.push(i)
  }
  return offsets
}

/** 偏移 → 1-based 行号（offsets 升序，二分）。 */
function lineAt(offsets, offset) {
  let lo = 0
  let hi = offsets.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid] < offset) lo = mid + 1
    else hi = mid
  }
  return lo + 1
}

/** 说明符的包根名：`fs/promises` → `fs`、`@scope/pkg/sub` → `@scope/pkg`。 */
function pkgRootOf(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/**
 * 说明符违反零依赖时返回原因，否则返回 undefined。
 * `testDeps` 是 package.json 的 devDependencies —— 只有 `__tests__/` 下的文件能用它们
 * （vitest 之类），要交付出去的那部分连 devDependency 也不许碰。
 */
function classify(specifier, testDeps) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return undefined
  if (specifier === SELF_PACKAGE || specifier.startsWith(`${SELF_PACKAGE}/`)) return undefined
  if (specifier.startsWith('node:')) return 'node 内置模块'
  if (BUILTINS.has(pkgRootOf(specifier))) {
    return 'node 内置模块（应写 node: 前缀，且本包不得使用）'
  }
  if (testDeps.has(pkgRootOf(specifier))) return undefined
  if (pkgRootOf(specifier) === 'electron') return 'electron'
  if (specifier.startsWith('@universe-editor/')) return '其它 workspace 包'
  return '未声明的裸说明符（本包 dependencies 必须为空）'
}

function fmt(p) {
  return p.replace(/\\/g, '/')
}

function collectFiles(dir, files = []) {
  if (!existsSync(dir)) return files
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collectFiles(join(dir, entry.name), files)
    } else if (entry.isFile() && SOURCE_EXT.test(entry.name)) {
      files.push(join(dir, entry.name))
    }
  }
  return files
}

export function checkPrimitivesDeps({ repoRoot = REPO_ROOT } = {}) {
  const pkgDir = join(repoRoot, PRIMITIVES_DIR)
  const violations = []
  if (!existsSync(pkgDir)) {
    return {
      scanned: 0,
      violations: [{ file: PRIMITIVES_DIR, line: 0, text: '', reason: '包目录不存在' }],
    }
  }

  const manifestRel = `${PRIMITIVES_DIR}/package.json`
  let testDeps = new Set()
  if (!existsSync(join(pkgDir, 'package.json'))) {
    violations.push({ file: manifestRel, line: 0, text: '', reason: '缺少 package.json' })
  } else {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    const deps = Object.keys(manifest.dependencies ?? {})
    if (deps.length > 0) {
      violations.push({
        file: manifestRel,
        line: 0,
        text: '',
        reason: `dependencies 必须为空，实际声明了 ${deps.join(', ')}`,
      })
    }
    testDeps = new Set(Object.keys(manifest.devDependencies ?? {}).map(pkgRootOf))
  }

  const files = collectFiles(join(pkgDir, 'src'))
  let scanned = 0
  for (const file of files) {
    const rel = fmt(relative(repoRoot, file))
    scanned++
    const source = readFileSync(file, 'utf8')
    const originalLines = source.split(/\r?\n/)
    const { text, unterminated } = stripComments(source)
    if (unterminated) {
      violations.push({ file: rel, line: 0, text: '', reason: unterminated })
      continue
    }
    const newlines = newlineOffsets(text)
    const inTests = rel.includes('/__tests__/')
    for (const re of SPECIFIER_RES) {
      re.lastIndex = 0
      for (const match of text.matchAll(re)) {
        const line = lineAt(newlines, match.index)
        const raw = originalLines[line - 1] ?? ''
        if (raw.includes(ALLOW_MARKER)) continue
        const reason = classify(match[1], inTests ? testDeps : new Set())
        if (reason) {
          violations.push({ file: rel, line, text: raw.trim(), reason })
        }
      }
    }
  }
  // 按文件/行排序：上面是逐正则收集的，跨行说明符会让「同一文件的两条」落到不同
  // 正则组里，直接打印会看着乱序。行号取关键字所在行（跨行写法指向语句开头）。
  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  return { scanned, violations }
}

function main() {
  const { scanned, violations } = checkPrimitivesDeps()
  if (violations.length > 0) {
    console.error(
      `[primitives] ${violations.length} 处违反零依赖不变量（扫描 ${scanned} 个源文件 + package.json）:`,
    )
    for (const { file, line, text, reason } of violations) {
      const at = line > 0 ? `${file}:${line}` : file
      console.error(`  - ${at}  ${reason}${text ? `  →  ${text.slice(0, 80)}` : ''}`)
    }
    console.error(
      `  primitives 不得 import node 内置模块 / electron / 其它 workspace 包，dependencies 必须为空；` +
        `确属无害时在该行加 ${ALLOW_MARKER} 注释。`,
    )
    if (CHECK_ONLY) process.exit(1)
  } else {
    console.log(`[primitives] 零依赖不变量成立（${scanned} 个源文件 + package.json）✓`)
  }
}

// 被测试 import 时不执行 main
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
