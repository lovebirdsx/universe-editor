#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  check-temp-root.mjs — 禁止各处直接拼 os.tmpdir()。
 *
 *  裸调 os.tmpdir() 会把临时目录写进用户 profile（Windows 上 %TEMP% 就在 profile 内），
 *  堆积到几十万条目后 Windows 登录的 User Profile Service 遍历要分钟级。统一走
 *  packages/temp-root（TS）或 scripts/lib/temp-root.mjs（根目录裸 node 脚本），
 *  它们把根收敛到仓库同盘的 <volume>/UniverseTmp，并允许 UNIVERSE_TMP_ROOT 覆盖。
 *
 *  本文件自身、两个 helper 实现、以及 helper 的单测需要造「非默认根」，在白名单里。
 *  确有无害巧合时在该行加 `temp-root:allow` 注释豁免。
 *
 *  Usage:
 *    node scripts/check-temp-root.mjs           # 报告，退出码 0
 *    node scripts/check-temp-root.mjs --check    # CI: 命中即退出 1
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHECK_ONLY = process.argv.slice(2).includes('--check')

// vendor/ 是 git submodule（claude-agent-acp / codex-acp fork），红线是 diff 最小，不纳入扫描；
// 它们的临时目录反正建在 run 根内，前缀已登记进 TEMP_PREFIXES 由清理命令兜底。
const SCAN_ROOTS = ['apps', 'packages', 'extensions', 'extensions-external', 'scripts']
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-bundle',
  'out',
  'out-dev',
  'release',
  '.turbo',
  'test-results',
  'playwright-report',
  '.runtime-resources',
  'coverage',
  'market-stage',
])
// 生成物：`packages/remote-server/.tmp-bootstrap-*` 是 bundle 出来的 bootstrap，含 dist 里的
// os.tmpdir() 文本；`.tmp-*` 全体在 .gitignore 内。
const SKIP_NAME = /^\.tmp-/
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx)$/
const TMPDIR_CALL = /\btmpdir\s*\(/
const ALLOW_MARKER = 'temp-root:allow'
// 整行注释：散文里提到 os.tmpdir() 是说明性的，不是调用点。（代价是被注释掉的死代码不会被发现。）
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/

/**
 * 只留代码，剥掉字符串字面量与行尾注释。少了这步，`const x = 1 // 老实现用 tmpdir()` 或错误
 * 文案里的 'os.tmpdir()' 都会误报——误报一多，大家就习惯性加 allow 标记，护栏就烂了。
 * 只跟踪引号/注释状态，不解析正则字面量（本仓库两者不会撞在一起）。
 */
function codeOnly(line) {
  let out = ''
  let quote
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote !== undefined) {
      if (ch === '\\') i++
      else if (ch === quote) quote = undefined
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '/' && line[i + 1] === '/') break
    out += ch
  }
  return out
}

/** 白名单：实现本身、造「非默认根」的单测、以及需要扫历史 %TEMP% 的清理命令。 */
const ALLOWED_FILES = new Set([
  'packages/temp-root/src/index.ts',
  'packages/temp-root/src/__tests__/tempRoot.test.ts',
  'scripts/lib/temp-root.mjs',
  'scripts/check-temp-root.mjs',
  // 默认扫描根就是「临时根 + os.tmpdir()」——历史残留都在后者里，绕不开
  'scripts/clean-temp.mjs',
])

function fmt(p) {
  return p.replace(/\\/g, '/')
}

function collectFiles(dir, files = []) {
  if (!existsSync(dir)) return files
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || SKIP_NAME.test(entry.name)) continue
      collectFiles(join(dir, entry.name), files)
    } else if (entry.isFile() && SOURCE_EXT.test(entry.name)) {
      files.push(join(dir, entry.name))
    }
  }
  return files
}

export function checkTempRoot({ repoRoot = REPO_ROOT, allowed = ALLOWED_FILES } = {}) {
  const files = []
  for (const root of SCAN_ROOTS) collectFiles(join(repoRoot, root), files)

  const violations = []
  let scanned = 0
  for (const file of files) {
    const rel = fmt(relative(repoRoot, file))
    if (allowed.has(rel)) continue
    scanned++
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    for (const [index, line] of lines.entries()) {
      if (COMMENT_LINE.test(line)) continue
      const code = codeOnly(line)
      if (!TMPDIR_CALL.test(code)) continue
      if (line.includes(ALLOW_MARKER)) continue
      violations.push({ file: rel, line: index + 1, text: line.trim() })
    }
  }
  return { scanned, violations }
}

function main() {
  const { scanned, violations } = checkTempRoot()
  if (violations.length > 0) {
    console.error(
      `[temp-root] ${violations.length} 处直接使用 os.tmpdir()（扫描 ${scanned} 个文件）:`,
    )
    for (const { file, line, text } of violations) {
      console.error(`  - ${file}:${line}  ${text.slice(0, 100)}`)
    }
    console.error(
      `  改用 mkTempDir(prefix)（packages/temp-root 或 scripts/lib/temp-root.mjs）；` +
        `确属无害时在该行加 ${ALLOW_MARKER} 注释。`,
    )
    if (CHECK_ONLY) process.exit(1)
  } else {
    console.log(`[temp-root] ${scanned} 个源文件均未直接使用 os.tmpdir() ✓`)
  }
}

// 被测试 import 时不执行 main
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
