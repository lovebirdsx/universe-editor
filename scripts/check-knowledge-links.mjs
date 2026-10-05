/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  check-knowledge-links.mjs — verify that repo paths referenced from knowledge
 *  docs (skills + CLAUDE.md files) still exist, so context maps don't silently
 *  drift from the code they describe.
 *
 *  Scans every knowledge container — `.claude/skills/<name>/SKILL.md` plus its
 *  `references/*.md` cases, every CLAUDE.md in the repo, every same-directory
 *  `cases-*.md` (the relief valve for CLAUDE.md overflow), every
 *  `docs/development/*.md` (cross-module long-form), and `vendor/<name>/CLAUDE.md`
 *  (one level only — fork internals are exempt, including their cases files) —
 *  for inline code spans (`...`) that look like repo-root-anchored paths
 *  (apps/ packages/ extensions/ vendor/ scripts/ docs/ .claude/) or skill-relative
 *  `references/` paths. `[[slug]]` wikilink residue from the retired memory layer
 *  is flagged too. Templates containing < > * { } … or ... are ignored, as are
 *  build artifacts (out/ dist/ node_modules/). `.js` suffixes also match
 *  `.ts`/`.tsx` sources.
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

// 知识文档 = 目录地图 CLAUDE.md、其溢出承接 cases-*.md、跨模块长文
// docs/development/*.md、skill 正文与案例（SKILL.md + references/*.md）。
// 都是「按需读取」的知识容器，路径引用同样会漂移。
function isKnowledgeDoc(name) {
  return name === 'CLAUDE.md' || /^cases-.+\.md$/.test(name)
}

function isDevelopmentDoc(fullPath) {
  const rel = fmt(relative(REPO_ROOT, fullPath))
  return rel.startsWith('docs/development/') && rel.endsWith('.md')
}

function collectFiles(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        // vendor：不递归整棵 fork，但下沉一层收 fork 根部的 CLAUDE.md
        // （cases-*.md 是 fork 内部文件，与其余 fork 内部实现一同豁免）
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
    } else if (entry.isFile()) {
      const full = join(dir, entry.name)
      if (isKnowledgeDoc(entry.name) || isDevelopmentDoc(full)) files.push(full)
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
    const refs = join(SKILLS_DIR, name, 'references')
    if (!existsSync(refs)) continue
    for (const f of readdirSync(refs)) {
      if (f.endsWith('.md')) files.push(join(refs, f))
    }
  }
  return files
}

// memory 层已下线（2026-10 迁移）：`[[kebab-slug]]` 是它的 wikilink 形态，任何残留都是
// 悬空引用——即便指向 skill，也一律改写成 `反引号` 或相对 markdown 链接。
function findWikilinks(source) {
  const found = []
  const re = /\[\[([a-z0-9]+(?:-[a-z0-9]+)+)\]\]/g
  let m
  while ((m = re.exec(source)) !== null) found.push(m[1])
  return found
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

function isVendorCheckedOut(name) {
  try {
    return readdirSync(join(REPO_ROOT, 'vendor', name)).length > 0
  } catch {
    return false
  }
}

function pathExists(candidate, baseDir) {
  // Strip line refs / anchors / trailing slash
  const cleaned = candidate.replace(/[:#].*$/, '').replace(/\/+$/, '')
  if (!cleaned) return true
  if (/(^|\/)(out|dist|node_modules)(\/|$)/.test(cleaned)) return true
  // vendor/* 是 submodule，CI 的 checkout 不拉子模块（fork 内部本就在豁免扫描之列），
  // 此时 fork 内部路径无从核验——跳过而不是误报；拉了的机器上照常校验。
  const vendorName = cleaned.startsWith('vendor/') ? cleaned.split('/')[1] : undefined
  if (vendorName !== undefined && !isVendorCheckedOut(vendorName)) return true
  // 优先按仓库根锚定解析；找不到再回退到相对当前文档目录（markdown 链接语义，
  // 与 LSP 一致，如 extensions/perforce/CLAUDE.md 里的 `docs/graph.md`）。
  // 两处都不存在才算死链，校验严格性不变。
  const full = candidate.startsWith('references/')
    ? join(baseDir, cleaned)
    : join(REPO_ROOT, cleaned)
  if (existsSync(full)) return true
  if (cleaned.endsWith('.js')) {
    const stem = full.slice(0, -3)
    if (existsSync(`${stem}.ts`) || existsSync(`${stem}.tsx`)) return true
  }
  if (!candidate.startsWith('references/')) {
    const local = join(baseDir, cleaned)
    if (existsSync(local)) return true
    if (cleaned.endsWith('.js')) {
      const stem = local.slice(0, -3)
      if (existsSync(`${stem}.ts`) || existsSync(`${stem}.tsx`)) return true
    }
  }
  return false
}

function main() {
  const docs = [...collectFiles(REPO_ROOT), ...collectSkillDocs()]
  const broken = []

  for (const doc of docs) {
    const source = readFileSync(doc, 'utf8')
    for (const candidate of extractCandidates(source)) {
      if (!pathExists(candidate, dirname(doc))) {
        broken.push(`${fmt(relative(REPO_ROOT, doc))}: \`${candidate}\``)
      }
    }
    for (const slug of findWikilinks(source)) {
      broken.push(`${fmt(relative(REPO_ROOT, doc))}: [[${slug}]] — memory 层已下线，改用反引号或相对链接`)
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
