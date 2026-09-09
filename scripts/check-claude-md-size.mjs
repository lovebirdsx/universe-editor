#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  check-claude-md-size.mjs — enforce a hard size budget on CLAUDE.md files so
 *  context maps stay lean and don't bloat the token window for agents reading
 *  them before every task.
 *
 *  Scans every CLAUDE.md in the repo (including vendor/<name>/CLAUDE.md one
 *  level deep, matching check-knowledge-links.mjs), excluding node_modules /
 *  .git / dist / out / .turbo. Files over MAX_BYTES are listed; --check exits
 *  with code 1.
 *
 *  Usage:
 *    node scripts/check-claude-md-size.mjs           # report only, exit 0
 *    node scripts/check-claude-md-size.mjs --check    # CI: exit 1 on oversize
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_BYTES = 15_000

const CHECK_ONLY = process.argv.slice(2).includes('--check')

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.turbo', 'vendor'])

// 豁免名单：因故暂无法压到预算内的文件，各附原因。当前无豁免——全仓硬限制生效。
const EXEMPT = new Set([])

function fmt(p) {
  return p.replace(/\\/g, '/')
}

function collectFiles(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        // vendor：不递归整棵 fork，但下沉一层收 fork 根部的 CLAUDE.md
        if (entry.name === 'vendor') {
          const vendorDir = join(dir, entry.name)
          if (!existsSync(vendorDir)) continue
          for (const sub of readdirSync(vendorDir, { withFileTypes: true })) {
            if (!sub.isDirectory()) continue
            const p = join(vendorDir, sub.name, 'CLAUDE.md')
            if (existsSync(p)) files.push(p)
          }
        }
        continue
      }
      collectFiles(join(dir, entry.name), files)
    } else if (entry.isFile() && entry.name === 'CLAUDE.md') {
      files.push(join(dir, entry.name))
    }
  }
  return files
}

export function checkClaudeMdSize({ repoRoot = REPO_ROOT, maxBytes = MAX_BYTES, exempt = EXEMPT } = {}) {
  const files = collectFiles(repoRoot)
  const oversize = []
  for (const file of files) {
    const rel = fmt(relative(repoRoot, file))
    if (exempt.has(rel)) continue
    const size = statSync(file).size
    if (size > maxBytes) oversize.push({ file: rel, size })
  }
  oversize.sort((a, b) => b.size - a.size)
  return { total: files.length, oversize }
}

function main() {
  const { total, oversize } = checkClaudeMdSize()
  if (oversize.length > 0) {
    console.error(
      `[claude-md-size] ${oversize.length} 个 CLAUDE.md 超过 ${MAX_BYTES} bytes 预算:`,
    )
    for (const { file, size } of oversize) {
      console.error(`  - ${file} (${size} bytes, 超出 ${size - MAX_BYTES})`)
    }
    if (CHECK_ONLY) process.exit(1)
  } else {
    console.log(
      `[claude-md-size] ${total} 个 CLAUDE.md 全部在 ${MAX_BYTES} bytes 预算内 ✓`,
    )
  }
}

// 被测试 import 时不执行 main
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
