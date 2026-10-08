/*---------------------------------------------------------------------------------------------
 *  继承发布入口退役护栏：`vendor/claude-agent-acp`（自维护 fork）的 .github/workflows 不得
 *  再保留会触发 npm 发布 / tag 创建 / 外部 registry dispatch 的入口（曾继承上游 publish.yml）。
 *  规则只在脚本测试里守卫，不进生产代码；负向验证：还原 publish.yml 时本测试必须变红。
 *
 *  fork 是 submodule：普通 `ci` job 不拉子模块（`pnpm test:release` 里本文件自行 skip），
 *  由带 `submodules: recursive` 的 `acp-contract` job 显式跑一次，否则护栏在 CI 从不真正执行。
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLAUDE_WORKFLOWS = join(REPO_ROOT, 'vendor', 'claude-agent-acp', '.github', 'workflows')

const FORBIDDEN_MARKERS = [
  'npm publish',
  'npm version',
  'create-github-app-token',
  'release-please-action',
  'refs/tags',
  'gh workflow run',
  'id-token: write',
  'contents: write',
]

/** 目录下所有 workflow 源文件（.yml/.yaml）。 */
function readWorkflows(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => ({ name, source: readFileSync(join(dir, name), 'utf8') }))
}

test(
  'claude-agent-acp：publish.yml 已退役，且不再有任何发布入口',
  { skip: !existsSync(CLAUDE_WORKFLOWS) && 'vendor/claude-agent-acp 未检出（submodule）' },
  () => {
    assert.equal(
      existsSync(join(CLAUDE_WORKFLOWS, 'publish.yml')),
      false,
      '继承的 publish.yml 必须删除（push/main 与手动发布路径一并退役）',
    )
    const hits = []
    for (const { name, source } of readWorkflows(CLAUDE_WORKFLOWS)) {
      for (const marker of FORBIDDEN_MARKERS) {
        if (source.includes(marker)) hits.push(`${name}: ${marker}`)
      }
    }
    assert.deepEqual(hits, [], `claude fork 仍保留发布入口：\n  - ${hits.join('\n  - ')}`)
  },
)

test(
  'claude-agent-acp：保留 ci.yml 作为唯一 CI（只读权限，格式/lint/构建/测试）',
  { skip: !existsSync(CLAUDE_WORKFLOWS) && 'vendor/claude-agent-acp 未检出（submodule）' },
  () => {
    const ci = readFileSync(join(CLAUDE_WORKFLOWS, 'ci.yml'), 'utf8')
    for (const step of [
      'npm ci',
      'npm run format:check',
      'npm run lint',
      'npm run build',
      'npm run test:run',
    ]) {
      assert.ok(ci.includes(step), `ci.yml 应保留 ${step}`)
    }
    assert.ok(ci.includes('contents: read'), 'ci.yml 权限应为 contents: read（无发布副作用）')
  },
)
