/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  lint-skills.mjs — lint `.claude/skills/<name>/SKILL.md` frontmatter:
 *    description: <= 400 bytes — trigger conditions only; rationale goes in the body
 *
 *  skill 的发现靠 harness 注入的 description（每次会话自动进上下文），仓库不再
 *  维护额外的路由表——本脚本只做规范校验，lint 失败即退出码 1（CI 经 `pnpm
 *  skills:check` 调用）。
 *
 *  Usage:
 *    node scripts/lint-skills.mjs
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS_DIR = join(REPO_ROOT, '.claude', 'skills')

const DESCRIPTION_LIMIT = 400

function byteLen(s) {
  return Buffer.byteLength(s, 'utf8')
}

/** Minimal frontmatter reader: single-line `key: value` pairs between --- fences. */
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return null
  const fields = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(line)
    if (kv) fields[kv[1]] = kv[2].trim()
  }
  return fields
}

function collectSkills() {
  if (!existsSync(SKILLS_DIR)) return []
  return readdirSync(SKILLS_DIR)
    .filter((name) => {
      try {
        return statSync(join(SKILLS_DIR, name)).isDirectory()
      } catch {
        return false
      }
    })
    .sort()
}

function lintSkill(name, fields) {
  const errors = []
  if (!fields) return [`SKILL.md 缺少 frontmatter`]
  if (fields['name'] && fields['name'] !== name) {
    errors.push(`frontmatter name "${fields['name']}" 与目录名 "${name}" 不一致`)
  }
  const desc = fields['description'] ?? ''
  if (!desc) errors.push('缺 description')
  else if (byteLen(desc) > DESCRIPTION_LIMIT) {
    errors.push(`description ${byteLen(desc)}B 超过 ${DESCRIPTION_LIMIT}B 上限（核心心智请移到正文）`)
  }
  return errors
}

function main() {
  const errors = []
  const skills = collectSkills()
  for (const name of skills) {
    const skillMd = join(SKILLS_DIR, name, 'SKILL.md')
    if (!existsSync(skillMd)) {
      errors.push(`${name}: 缺 SKILL.md`)
      continue
    }
    const fields = parseFrontmatter(readFileSync(skillMd, 'utf8'))
    for (const e of lintSkill(name, fields)) errors.push(`${name}: ${e}`)
  }

  if (errors.length > 0) {
    console.error('[skills-lint] frontmatter lint 失败:')
    errors.forEach((e) => console.error(`  - ${e}`))
    process.exit(1)
  }
  console.log(`[skills-lint] lint 通过（${skills.length} 个 skill）✓`)
}

main()
