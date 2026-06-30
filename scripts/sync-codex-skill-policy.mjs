/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Keeps each Claude skill's Codex-side invocation policy in sync.
 *
 *  Skills live in `.claude/skills/<name>/SKILL.md` and are shared by both built-in
 *  agents (the codex-acp adapter exposes `.claude/skills` to Codex; see
 *  `vendor/codex-acp/src/CodexAcpClient.ts` `refreshSkills`). Claude reads the
 *  `disable-model-invocation` frontmatter to keep a skill manual-only; Codex reads
 *  `policy.allow_implicit_invocation` from a per-skill `agents/openai.yaml` instead.
 *
 *  This script mirrors the former into the latter: every skill whose SKILL.md has
 *  `disable-model-invocation: true` gets an `agents/openai.yaml` with
 *  `policy.allow_implicit_invocation: false`, so it is manual-only (`$skill`) on
 *  Codex too — matching Claude's `/skill`. Idempotent: safe to re-run after adding
 *  a new skill. Claude ignores the `agents/` subdir, so this is a no-op for Claude.
 *
 *  Usage:
 *    node scripts/sync-codex-skill-policy.mjs           # write/refresh openai.yaml
 *    node scripts/sync-codex-skill-policy.mjs --check    # CI: fail if any out of sync
 *--------------------------------------------------------------------------------------------*/

import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const SKILLS_DIR = join(REPO_ROOT, '.claude', 'skills')

const CHECK_ONLY = process.argv.slice(2).includes('--check')

// Codex's manual-only policy file. Mirrors Claude's `disable-model-invocation: true`:
// the skill is not injected into the model context by default, but stays invocable
// explicitly via `$skill`. See codex docs (policy.allow_implicit_invocation).
const OPENAI_YAML = ['policy:', '  allow_implicit_invocation: false', ''].join('\n')

function fmt(p) {
  return p.replace(/\\/g, '/')
}

/** A skill is manual-only when its SKILL.md frontmatter disables model invocation. */
function isManualOnly(skillMdPath) {
  let text
  try {
    text = readFileSync(skillMdPath, 'utf8')
  } catch {
    return false
  }
  return /^\s*disable-model-invocation:\s*true\s*$/m.test(text)
}

function main() {
  if (!existsSync(SKILLS_DIR)) {
    console.error(`[skill-policy] 找不到 skills 目录: ${fmt(SKILLS_DIR)}`)
    process.exit(1)
  }

  const entries = readdirSync(SKILLS_DIR).filter((name) => {
    try {
      return statSync(join(SKILLS_DIR, name)).isDirectory()
    } catch {
      return false
    }
  })

  const outOfSync = []
  let written = 0
  let skipped = 0

  for (const name of entries.sort()) {
    const skillDir = join(SKILLS_DIR, name)
    const skillMd = join(skillDir, 'SKILL.md')
    if (!existsSync(skillMd)) continue

    // Only manual-only skills get the manual-only Codex policy. A skill that
    // intentionally allows auto-invocation should not be forced off here.
    if (!isManualOnly(skillMd)) {
      skipped++
      continue
    }

    const yamlPath = join(skillDir, 'agents', 'openai.yaml')
    const current = existsSync(yamlPath) ? readFileSync(yamlPath, 'utf8') : null
    const inSync = current !== null && current.replace(/\r\n/g, '\n') === OPENAI_YAML

    if (inSync) {
      skipped++
      continue
    }

    if (CHECK_ONLY) {
      outOfSync.push(name)
      continue
    }

    mkdirSync(dirname(yamlPath), { recursive: true })
    writeFileSync(yamlPath, OPENAI_YAML, 'utf8')
    console.log(`[skill-policy] 写入 ${fmt(join(name, 'agents', 'openai.yaml'))}`)
    written++
  }

  if (CHECK_ONLY) {
    if (outOfSync.length > 0) {
      console.error('[skill-policy] 以下 skill 的 Codex 策略文件缺失或过期:')
      outOfSync.forEach((n) => console.error(`  - ${n}`))
      console.error('[skill-policy] 运行 `pnpm skills:policy` 修复。')
      process.exit(1)
    }
    console.log('[skill-policy] 所有手动 skill 的 Codex 策略已同步 ✓')
    return
  }

  console.log(`[skill-policy] 完成 ✓ 写入 ${written} 个, 跳过 ${skipped} 个`)
}

main()
