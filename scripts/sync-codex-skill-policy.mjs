/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Ensures every skill carries a Codex-side invocation policy file.
 *
 *  Skills live in `.claude/skills/<name>/SKILL.md` and are shared by both built-in
 *  agents (the codex-acp adapter exposes `.claude/skills` to Codex; see
 *  `vendor/codex-acp/src/CodexAcpClient.ts` `refreshSkills`). Each side reads its
 *  own native knob — there is no bridging frontmatter:
 *    Claude: `disable-model-invocation` frontmatter (harness reads it directly)
 *    Codex:  `policy.allow_implicit_invocation` in per-skill `agents/openai.yaml`
 *            (the Codex binary scans skill dirs and reads this file itself)
 *
 *  `agents/openai.yaml` is the single source of truth for the Codex side. This
 *  script does NOT derive it from anything: it only writes the default
 *  `allow_implicit_invocation: false` (manual-only in product-side Codex sessions)
 *  when the file is missing, and validates existing files. To open one skill to
 *  implicit invocation on Codex, hand-edit its openai.yaml to `true` — the script
 *  respects handwritten values. Claude ignores the `agents/` subdir entirely.
 *
 *  Usage:
 *    node scripts/sync-codex-skill-policy.mjs           # fill in missing openai.yaml
 *    node scripts/sync-codex-skill-policy.mjs --check    # CI: fail on missing/invalid
 *--------------------------------------------------------------------------------------------*/

import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const SKILLS_DIR = join(REPO_ROOT, '.claude', 'skills')

const CHECK_ONLY = process.argv.slice(2).includes('--check')

const VALID = new Set(['true', 'false'])

function fmt(p) {
  return p.replace(/\\/g, '/')
}

function openaiYaml(allowImplicit) {
  return ['policy:', `  allow_implicit_invocation: ${allowImplicit}`, ''].join('\n')
}

/** Returns 'true' | 'false' when the file carries a valid policy, null otherwise. */
function readPolicy(yamlPath) {
  if (!existsSync(yamlPath)) return null
  const m = /^policy:\s*\r?\n\s+allow_implicit_invocation:\s*(true|false)\s*$/m.exec(
    readFileSync(yamlPath, 'utf8'),
  )
  return m && VALID.has(m[1]) ? m[1] : null
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

  const invalid = []
  let written = 0
  let kept = 0

  for (const name of entries.sort()) {
    const skillDir = join(SKILLS_DIR, name)
    if (!existsSync(join(skillDir, 'SKILL.md'))) continue

    const yamlPath = join(skillDir, 'agents', 'openai.yaml')
    const policy = readPolicy(yamlPath)

    if (policy !== null) {
      kept++
      continue
    }

    if (existsSync(yamlPath)) {
      invalid.push(name)
      continue
    }

    if (CHECK_ONLY) {
      invalid.push(name)
      continue
    }

    mkdirSync(dirname(yamlPath), { recursive: true })
    writeFileSync(yamlPath, openaiYaml('false'), 'utf8')
    console.log(`[skill-policy] 写入 ${fmt(join(name, 'agents', 'openai.yaml'))}（默认 false）`)
    written++
  }

  if (invalid.length > 0) {
    console.error('[skill-policy] 以下 skill 缺 agents/openai.yaml 或内容非法:')
    invalid.forEach((n) => console.error(`  - ${n}`))
    console.error('[skill-policy] 运行 `pnpm skills:policy` 补齐（默认 false），或手写合法 policy。')
    process.exit(1)
  }

  if (CHECK_ONLY) {
    console.log(`[skill-policy] 所有 skill 的 Codex 策略文件齐备（${kept} 个）✓`)
    return
  }
  console.log(`[skill-policy] 完成 ✓ 写入 ${written} 个, 已有 ${kept} 个`)
}

main()
