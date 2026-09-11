#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  clean-temp.mjs — 按前缀 + TTL 收敛我们自己在临时根里留下的残留。
 *
 *  只删一级条目（目录与散文件），且名字必须命中 scripts/lib/temp-root.mjs 的 TEMP_PREFIXES。**不是**
 *  「清空 %TEMP%」的脚本：任何不在允许清单里的目录一律不碰。
 *
 *  默认扫两个根：getTempRoot()（新的临时根）与 os.tmpdir()（历史残留所在，Windows 上即
 *  用户 profile 内的 %TEMP%）。后者是存量收敛入口 —— 存量清理是运维动作，跑一次即可。
 *
 *  Usage:
 *    node scripts/clean-temp.mjs --dry-run                # 先看要删什么
 *    node scripts/clean-temp.mjs                          # 实际删除（默认 TTL 24 小时）
 *    node scripts/clean-temp.mjs --max-age-hours 72       # 放宽 TTL
 *    node scripts/clean-temp.mjs --root D:/UniverseTmp    # 指定根（可重复）
 *    node scripts/clean-temp.mjs --json                   # 机器可读输出
 *--------------------------------------------------------------------------------------------*/

import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  getTempRoot,
  sweepStaleTempDirs,
  TEMP_LIVE_DIR_NAMES,
  TEMP_PREFIXES,
} from './lib/temp-root.mjs'

function parseArgs(argv) {
  const opts = { dryRun: false, json: false, maxAgeHours: 24, roots: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--json') opts.json = true
    else if (arg === '--max-age-hours') {
      const value = Number(argv[++i])
      if (!Number.isFinite(value) || value < 0) throw new Error(`--max-age-hours 需要非负数`)
      opts.maxAgeHours = value
    } else if (arg === '--root') {
      const value = argv[++i]
      if (!value) throw new Error(`--root 需要一个路径`)
      opts.roots.push(resolve(value))
    } else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`未知参数: ${arg}`)
  }
  return opts
}

const HELP = `用法: node scripts/clean-temp.mjs [选项]

  --dry-run              只列出将被删除的条目，不实际删除
  --max-age-hours <n>    只删 mtime 早于 n 小时的条目（默认 24）
  --root <path>          指定扫描根，可重复（默认：临时根 + os.tmpdir()）
  --json                 输出 JSON
  -h, --help             显示本帮助

只删除一级条目，且名字必须命中以下前缀之一：
  ${TEMP_PREFIXES.join(' ')}
`

function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(HELP)
    return
  }

  const tempRoot = getTempRoot()
  const roots = opts.roots.length > 0 ? opts.roots : [tempRoot, tmpdir()]

  const result = sweepStaleTempDirs({
    maxAgeMs: opts.maxAgeHours * 60 * 60 * 1000,
    roots,
    dryRun: opts.dryRun,
    liveRoot: tempRoot,
  })

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          roots,
          liveRoot: tempRoot,
          liveDirNames: TEMP_LIVE_DIR_NAMES,
          maxAgeHours: opts.maxAgeHours,
          dryRun: opts.dryRun,
          scanned: result.scanned,
          candidates: result.candidates.length,
          removed: result.removed.length,
          failed: result.failed.length,
          bytes: result.bytes,
          truncated: result.truncated,
        },
        null,
        2,
      ),
    )
    if (result.failed.length > 0) process.exitCode = 1
    return
  }

  const verb = opts.dryRun ? '将删除' : '已删除'
  const count = opts.dryRun ? result.candidates.length : result.removed.length
  console.log(`[temp-clean] 扫描根: ${roots.join(' , ')}`)
  console.log(
    `[temp-clean] 共 ${result.scanned} 个一级条目，命中前缀且超过 ${opts.maxAgeHours} 小时的 ${verb} ${count} 个，回收 ${fmtBytes(result.bytes)}${result.truncated ? '(体积统计被截断，实际更大)' : ''}`,
  )
  if (opts.dryRun) {
    for (const item of result.candidates.slice(0, 50)) {
      console.log(`  - ${item.path}  ${fmtBytes(item.bytes)}`)
    }
    if (result.candidates.length > 50) {
      console.log(`  ... 另有 ${result.candidates.length - 50} 个`)
    }
    console.log(`[temp-clean] 预演模式，未删除任何目录。去掉 --dry-run 生效。`)
  }
  if (result.failed.length > 0) {
    console.error(`[temp-clean] ${result.failed.length} 个目录删除失败（多半被进程占用）:`)
    for (const path of result.failed.slice(0, 20)) console.error(`  - ${path}`)
    process.exitCode = 1
  }
}

try {
  main()
} catch (err) {
  console.error(`[temp-clean] ${String(err instanceof Error ? err.message : err)}`)
  process.exitCode = 1
}
