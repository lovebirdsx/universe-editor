/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  gate.mjs 测试：纯判定函数 + 临时 git 仓库集成（通过 / 违规各一组）+ hook 安装。
 *--------------------------------------------------------------------------------------------*/

import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkTempDir, removeDirWithRetry } from '../../lib/temp-root.mjs'
import {
  evaluateGate,
  installHook,
  isForbiddenPath,
  parseArgs,
  parseNumstat,
  resolveThresholds,
  runGate,
} from '../gate.mjs'

const GATE_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'gate.mjs')
const HAS_GIT = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0
const tempDirs = []

afterEach(() => {
  while (tempDirs.length > 0) removeDirWithRetry(tempDirs.pop())
})

function writeFile(root, relative, content) {
  const absolute = join(root, relative)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content)
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')} 失败: ${result.stderr}`)
  return result.stdout
}

function makeRepo() {
  const root = mkTempDir('tracker-test-')
  tempDirs.push(root)
  git(root, ['init'])
  git(root, ['config', 'user.email', 'testuser@example.com'])
  git(root, ['config', 'user.name', 'testuser'])
  writeFile(root, 'README.md', 'base\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', 'chore: base'])
  git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  return root
}

test('isForbiddenPath: 覆盖所有禁改路径族', () => {
  for (const path of [
    'pnpm-lock.yaml',
    'package.json',
    'apps/editor/package.json',
    'pnpm-workspace.yaml',
    '.github/workflows/ci.yml',
    'electron-builder.yml',
    'apps/editor/electron-builder.yml',
    'scripts/release/release.mjs',
    'scripts/server/server.mjs',
    'scripts/tracker/gate.mjs',
    'vendor/claude-agent-acp/dist/index.js',
    'packages/config-ts/base.json',
    '.env',
    'apps/editor/.env.local',
    'scripts/sensitive-rules.json',
    'CLAUDE.md',
    'apps/editor/CLAUDE.md',
  ]) {
    assert.equal(isForbiddenPath(path), true, path)
  }
  for (const path of ['scripts/tool.mjs', 'apps/editor/src/main.ts', 'docs/development/x.md']) {
    assert.equal(isForbiddenPath(path), false, path)
  }
})

test('resolveThresholds: 默认硬上限，只允许调低', () => {
  assert.deepEqual(resolveThresholds(), { maxFiles: 8, maxLines: 300 })
  assert.deepEqual(resolveThresholds({ maxFiles: 4, maxLines: 100 }), {
    maxFiles: 4,
    maxLines: 100,
  })
  assert.throws(() => resolveThresholds({ maxFiles: 9 }), /不能超过硬上限/)
  assert.throws(() => resolveThresholds({ maxLines: 0 }), /正整数/)
  assert.throws(() => resolveThresholds({ maxFiles: 1.5 }), /正整数/)
})

test('parseNumstat: 识别二进制改动', () => {
  assert.deepEqual(parseNumstat('3\t2\tsrc/a.ts\n-\t-\tassets/logo.png\n'), [
    { path: 'src/a.ts', additions: 3, deletions: 2, binary: false },
    { path: 'assets/logo.png', additions: null, deletions: null, binary: true },
  ])
})

test('evaluateGate: 逐项给出违规', () => {
  const files = Array.from({ length: 9 }, (_, index) => ({
    path: `src/f${index}.ts`,
    additions: 40,
    deletions: 0,
    binary: false,
  }))
  files.push({ path: 'package.json', additions: 1, deletions: 0, binary: false })
  files.push({ path: 'img.png', additions: null, deletions: null, binary: true })

  const result = evaluateGate({
    mergeCommits: ['abc123'],
    files,
    pendingCommits: 2,
    dailyTrackerCommits: 4,
    thresholds: { maxFiles: 8, maxLines: 300 },
  })

  assert.equal(result.ok, false)
  const joined = result.violations.join('\n')
  assert.match(joined, /merge commit/)
  assert.match(joined, /改动文件数 11 超过上限 8/)
  assert.match(joined, /增删行合计 361 超过上限 300/)
  assert.match(joined, /二进制改动/)
  assert.match(joined, /禁改路径/)
  assert.match(joined, /每日上限 5/)
})

test('parseArgs: 基准、阈值与 hook 参数', () => {
  assert.deepEqual(parseArgs(['--base', 'main', '--max-files', '4', '--install-hook']), {
    base: 'main',
    maxFiles: 4,
    installHook: true,
  })
  assert.throws(() => parseArgs(['--max-files', 'x']), /整数/)
  assert.throws(() => parseArgs(['--unknown']), /未知参数/)
})

test('集成: 范围内的提交通过', { skip: !HAS_GIT }, () => {
  const root = makeRepo()
  writeFile(root, 'scripts/tool.mjs', 'export const x = 1\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', 'feat(tool): add tool'])

  const result = runGate({ repoRoot: root })
  assert.equal(result.ok, true, result.violations.join('; '))
  assert.equal(result.stats.commits, 1)
  assert.equal(result.stats.files, 1)
  assert.equal(result.stats.lines, 1)

  const cli = spawnSync(process.execPath, [GATE_SCRIPT], { cwd: root, encoding: 'utf8' })
  assert.equal(cli.status, 0, cli.stdout + cli.stderr)
  assert.match(cli.stdout, /结果: 通过/)
})

test('集成: 禁改路径与阈值违规时失败', { skip: !HAS_GIT }, () => {
  const root = makeRepo()
  writeFile(root, 'package.json', '{}\n')
  writeFile(root, 'scripts/a.mjs', 'export const a = 1\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', 'feat: touch lockfile'])

  const forbidden = runGate({ repoRoot: root })
  assert.equal(forbidden.ok, false)
  assert.match(forbidden.violations.join('\n'), /package\.json/)

  const tooMany = runGate({ repoRoot: root, maxFiles: 1 })
  assert.equal(tooMany.ok, false)
  assert.match(tooMany.violations.join('\n'), /改动文件数 2 超过上限 1/)

  const cli = spawnSync(process.execPath, [GATE_SCRIPT], { cwd: root, encoding: 'utf8' })
  assert.equal(cli.status, 1)
  assert.match(cli.stdout, /结果: 未通过/)
})

test('集成: 没有待推送提交时通过，不把反向 diff 当改动', { skip: !HAS_GIT }, () => {
  const root = makeRepo()
  writeFile(root, 'later.txt', 'later\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', 'chore: later'])
  git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  git(root, ['reset', '--hard', 'HEAD~1'])

  const result = runGate({ repoRoot: root })
  assert.equal(result.ok, true)
  assert.equal(result.stats.commits, 0)
  assert.equal(result.stats.files, 0)
})

test('集成: 每日配额统计 origin/main 最近 24h 的 Refs: tracker# 提交', { skip: !HAS_GIT }, () => {
  const root = makeRepo()
  for (let index = 1; index <= 5; index++) {
    writeFile(root, `base-${index}.txt`, 'x\n')
    git(root, ['add', '-A'])
    git(root, ['commit', '-m', `chore: base ${index}\n\nRefs: tracker#${index}`])
  }
  git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])

  writeFile(root, 'scripts/tool.mjs', 'export const x = 1\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', 'feat: next\n\nRefs: tracker#99'])

  const result = runGate({ repoRoot: root })
  assert.equal(result.stats.dailyTrackerCommits, 5)
  assert.equal(result.ok, false)
  assert.match(result.violations.join('\n'), /每日上限 5/)
})

test('集成: --install-hook 拒绝覆盖第三方 hook', { skip: !HAS_GIT }, () => {
  const root = makeRepo()
  const hooksDir = join(root, '.git', 'hooks')
  mkdirSync(hooksDir, { recursive: true })
  writeFileSync(join(hooksDir, 'pre-push'), '#!/bin/sh\necho custom\n')

  assert.throws(() => installHook({ repoRoot: root }), /拒绝覆盖/)

  rmSync(join(hooksDir, 'pre-push'))
  const hookPath = installHook({ repoRoot: root })
  assert.match(readFileSync(hookPath, 'utf8'), /UE_TRACKER_GATE/)
})
