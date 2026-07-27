/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  check-knowledge-links.mjs — verify that repo paths referenced from knowledge
 *  docs (skills + CLAUDE.md files + memory) still exist, so context maps don't
 *  silently drift from the code they describe.
 *
 *  Scans `.claude/skills/<name>/SKILL.md`, `.claude/memory/*.md`, every CLAUDE.md
 *  in the repo, and `vendor/<name>/CLAUDE.md` (one level only — fork internals
 *  are exempt) for inline code spans (`...`) that look like repo-root-anchored
 *  paths (apps/ packages/ extensions/ vendor/ scripts/ docs/ .claude/) or
 *  skill-relative `references/` paths. Templates containing < > * { } … or ...
 *  are ignored, as are build artifacts (out/ dist/ node_modules/). `.js`
 *  suffixes also match `.ts`/`.tsx` sources.
 *
 *  Usage:
 *    node scripts/check-knowledge-links.mjs           # report only, exit 0
 *    node scripts/check-knowledge-links.mjs --check    # CI: exit 1 on broken refs
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS_DIR = join(REPO_ROOT, '.claude', 'skills')
const MEMORY_DIR = join(REPO_ROOT, '.claude', 'memory')

const CHECK_ONLY = process.argv.slice(2).includes('--check')

const ROOT_PREFIXES = [
  'apps/',
  'packages/',
  'extensions/',
  'vendor/',
  'scripts/',
  'docs/',
  '.claude/',
]
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.turbo', 'vendor'])

// 文档示例/格式说明中的示意路径，非仓库真实引用
const IGNORE = new Set([
  'docs/sub/target.md',
  'docs/a.md',
  'scripts/pack.mjs',
  'apps/editor/e2e/specs/smoke.myThing.spec.ts', // 套路 F 的占位示例文件名
  'apps/editor/release/', // electron-builder 打包产物目录，与 out/ dist/ 同类，构建前不存在
  'vendor/group/model', // AI 模型标识符三段格式说明，非路径
  '.claude/settings.local.json', // 本机私有配置（gitignore），vendor fork 文档提及
])

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

function collectSkillDocs() {
  if (!existsSync(SKILLS_DIR)) return []
  const files = []
  for (const name of readdirSync(SKILLS_DIR)) {
    const p = join(SKILLS_DIR, name, 'SKILL.md')
    if (existsSync(p)) files.push(p)
  }
  return files
}

function collectMemoryDocs() {
  if (!existsSync(MEMORY_DIR)) return []
  return readdirSync(MEMORY_DIR)
    .filter((n) => n.endsWith('.md'))
    .map((n) => join(MEMORY_DIR, n))
}

/** Extract path candidates from inline code spans. */
function extractCandidates(source) {
  const candidates = []
  const spanRe = /`([^`\n]+)`/g
  let m
  while ((m = spanRe.exec(source)) !== null) {
    const raw = m[1].trim()
    if (/[<>*{}…$|]/.test(raw) || raw.includes('...')) continue
    if (raw.includes(' ')) continue
    const isRooted = ROOT_PREFIXES.some((p) => raw.startsWith(p))
    const isSkillRelative = raw.startsWith('references/')
    if (!isRooted && !isSkillRelative) continue
    if (IGNORE.has(raw)) continue
    candidates.push(raw)
  }
  return candidates
}

function pathExists(candidate, baseDir) {
  // Strip line refs / anchors / trailing slash
  const cleaned = candidate.replace(/[:#].*$/, '').replace(/\/+$/, '')
  if (!cleaned) return true
  if (/(^|\/)(out|dist|node_modules)(\/|$)/.test(cleaned)) return true
  const full = candidate.startsWith('references/')
    ? join(baseDir, cleaned)
    : join(REPO_ROOT, cleaned)
  if (existsSync(full)) return true
  if (cleaned.endsWith('.js')) {
    const stem = full.slice(0, -3)
    if (existsSync(`${stem}.ts`) || existsSync(`${stem}.tsx`)) return true
  }
  return false
}

function main() {
  const docs = [...collectFiles(REPO_ROOT), ...collectSkillDocs(), ...collectMemoryDocs()]
  const broken = []

  for (const doc of docs) {
    const source = readFileSync(doc, 'utf8')
    for (const candidate of extractCandidates(source)) {
      if (!pathExists(candidate, dirname(doc))) {
        broken.push(`${fmt(relative(REPO_ROOT, doc))}: \`${candidate}\``)
      }
    }
  }

  if (broken.length > 0) {
    console.error(`[knowledge-links] 发现 ${broken.length} 处失效路径引用:`)
    broken.forEach((b) => console.error(`  - ${b}`))
    if (CHECK_ONLY) process.exit(1)
  } else {
    console.log(`[knowledge-links] ${docs.length} 篇文档的路径引用全部有效 ✓`)
  }
}

main()
