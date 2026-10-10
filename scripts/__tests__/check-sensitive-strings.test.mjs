/*---------------------------------------------------------------------------------------------
 *  Tests for scripts/check-sensitive-strings.mjs. Run with `node --test`.
 *  覆盖：规则加载四态（missing/empty/parse-error/ok）、--check 的退出码、掩码输出、
 *  allow/allowMatch/sensitive-strings:allow 三级豁免、compileRule 结构映射、
 *  扫描集合来源（git 列表 vs 非 git 回退遍历）与 listGitFiles 的失败态。
 *  只打纯函数，绝不触发 process.exit（这是纯函数化的意义）。
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkSensitiveStrings,
  collectFiles,
  collectScanFiles,
  compileRule,
  formatGroupHeader,
  formatHit,
  listGitFiles,
  maskMatch,
} from '../check-sensitive-strings.mjs'
import { mkTempDir } from '../lib/temp-root.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HAS_GIT = (() => {
  const res = spawnSync('git', ['--version'], { stdio: 'ignore' })
  return !res.error && res.status === 0
})()

function makeRepo() {
  return mkTempDir('sensitive-strings-')
}

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, stdio: 'ignore' })
  assert.equal(res.status, 0, `git ${args.join(' ')} failed`)
}

function writeConfig(root, content) {
  const path = join(root, 'sensitive-rules.json')
  writeFileSync(path, content)
  return path
}

function writeSource(root, rel, content) {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

test('缺失规则文件 + --check 视为失败（核心回归）', () => {
  const root = makeRepo()
  const result = checkSensitiveStrings({
    repoRoot: root,
    configPath: join(root, 'nope.json'),
    check: true,
  })
  assert.equal(result.status, 'missing')
  assert.equal(result.exit, 1)
})

test('缺失规则文件 + 默认模式为 report-only（exit 0）', () => {
  const root = makeRepo()
  const result = checkSensitiveStrings({ repoRoot: root, configPath: join(root, 'nope.json') })
  assert.equal(result.status, 'missing')
  assert.equal(result.exit, 0)
})

test('缺失规则文件 + allowMissing 逃生阀降级为 warn', () => {
  const root = makeRepo()
  const result = checkSensitiveStrings({
    repoRoot: root,
    configPath: join(root, 'nope.json'),
    check: true,
    allowMissing: true,
  })
  assert.equal(result.status, 'missing-allowed')
  assert.equal(result.exit, 0)
})

test('非法 JSON + --check 失败且 error 不含原文片段', () => {
  const root = makeRepo()
  const configPath = writeConfig(root, '{ "bad-json-probe" bad json')
  const result = checkSensitiveStrings({ repoRoot: root, configPath, check: true })
  assert.equal(result.status, 'parse-error')
  assert.equal(result.exit, 1)
  assert.ok(result.error)
  assert.ok(!result.error.includes('bad-json-probe'))
})

test('顶层非数组 + --check 视为 parse-error', () => {
  const root = makeRepo()
  const configPath = writeConfig(root, '{"id":"x"}')
  const result = checkSensitiveStrings({ repoRoot: root, configPath, check: true })
  assert.equal(result.status, 'parse-error')
  assert.equal(result.exit, 1)
})

test('0 条规则 + --check 视为 empty 失败', () => {
  const root = makeRepo()
  const configPath = writeConfig(root, '[]')
  const result = checkSensitiveStrings({ repoRoot: root, configPath, check: true })
  assert.equal(result.status, 'empty')
  assert.equal(result.exit, 1)
})

test('正常命中：exit=1 且 file/line/match 正确', () => {
  const root = makeRepo()
  const configPath = writeConfig(
    root,
    JSON.stringify([
      { id: 'probe', desc: 'probe rule', pattern: 'leak\\.example\\.com', flags: 'gi' },
    ]),
  )
  writeSource(root, 'src/a.ts', 'const u = "https://leak.example.com"\n')
  const result = checkSensitiveStrings({ repoRoot: root, configPath, check: true })
  assert.equal(result.status, 'ok')
  assert.equal(result.exit, 1)
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].file, 'src/a.ts')
  assert.equal(result.findings[0].line, 1)
  assert.equal(result.findings[0].match, 'leak.example.com')
})

test('无命中：exit=0 且 ruleCount 正确回传', () => {
  const root = makeRepo()
  const configPath = writeConfig(
    root,
    JSON.stringify([
      { id: 'a', desc: 'a', pattern: 'never-match-1', flags: 'gi' },
      { id: 'b', desc: 'b', pattern: 'never-match-2', flags: 'gi' },
    ]),
  )
  writeSource(root, 'src/a.ts', 'nothing here\n')
  const result = checkSensitiveStrings({ repoRoot: root, configPath, check: true })
  assert.equal(result.status, 'ok')
  assert.equal(result.exit, 0)
  assert.equal(result.ruleCount, 2)
  assert.deepEqual(result.findings, [])
})

test('maskMatch：不含原文、不泄露长度、全量 hex sha、确定性', () => {
  const masked = maskMatch('leak.example.com')
  assert.ok(!masked.includes('leak.example.com'))
  assert.match(masked, /^sha=[0-9a-f]{64}$/)
  assert.ok(!masked.includes('len='))
  assert.equal(maskMatch('leak.example.com'), masked)
  assert.notEqual(maskMatch('other.example.com'), masked)
})

test('formatHit(mask=true)：不输出 match 但含 file:line', () => {
  const hit = { line: 3, match: 'leak.example.com' }
  const out = formatHit('src/a.ts', hit, true)
  assert.ok(!out.includes('leak.example.com'))
  assert.ok(out.includes('src/a.ts:3'))
})

test('formatGroupHeader(mask=true)：不输出 desc 但含 id', () => {
  const items = [
    { rule: { id: 'probe', desc: 'sensitive-desc-value' } },
    { rule: { id: 'probe', desc: 'x' } },
  ]
  const out = formatGroupHeader('probe', items, true)
  assert.ok(out.includes('probe'))
  assert.ok(!out.includes('sensitive-desc-value'))
  assert.ok(out.includes('2'))
})

test('sensitive-strings:allow 整行豁免', () => {
  const root = makeRepo()
  const configPath = writeConfig(
    root,
    JSON.stringify([
      { id: 'probe', desc: 'probe rule', pattern: 'leak\\.example\\.com', flags: 'gi' },
    ]),
  )
  writeSource(root, 'src/a.ts', 'const u = "https://leak.example.com" // sensitive-strings:allow\n')
  const result = checkSensitiveStrings({ repoRoot: root, configPath, check: true })
  assert.equal(result.exit, 0)
  assert.deepEqual(result.findings, [])
})

test('allow 整行豁免（行内含占位 IP 则整行放过）', () => {
  const root = makeRepo()
  const configPath = writeConfig(
    root,
    JSON.stringify([
      {
        id: 'probe',
        desc: 'probe rule',
        pattern: 'fakehost\\.example\\.com',
        flags: 'gi',
        allow: [{ pattern: '192\\.0\\.2\\.' }],
      },
    ]),
  )
  writeSource(root, 'src/a.ts', 'const ip = "192.0.2.1"; const h = "fakehost.example.com"\n')
  const result = checkSensitiveStrings({ repoRoot: root, configPath, check: true })
  assert.equal(result.exit, 0)
  assert.deepEqual(result.findings, [])
})

test('allowMatch 只豁免命中片段', () => {
  const root = makeRepo()
  const configPath = writeConfig(
    root,
    JSON.stringify([
      {
        id: 'probe',
        desc: 'probe rule',
        pattern: 'gallery\\.example\\.com|fakehost\\.example\\.com',
        flags: 'gi',
        allowMatch: [{ pattern: 'gallery\\.example\\.com' }],
      },
    ]),
  )
  writeSource(root, 'src/a.ts', 'gallery.example.com fakehost.example.com\n')
  const result = checkSensitiveStrings({ repoRoot: root, configPath, check: true })
  assert.equal(result.exit, 1)
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].match, 'fakehost.example.com')
})

test('compileRule：JSON 规则映射为运行时正则结构', () => {
  const rule = compileRule({
    id: 'probe',
    desc: 'probe rule',
    pattern: 'leak\\.example\\.com',
    flags: 'gi',
    allow: [{ pattern: '192\\.0\\.2\\.' }],
    allowMatch: [{ pattern: 'example\\.com' }],
  })
  assert.equal(rule.id, 'probe')
  assert.equal(rule.desc, 'probe rule')
  assert.ok(rule.re instanceof RegExp)
  assert.equal(rule.re.flags, 'gi')
  assert.ok(rule.re.test('leak.example.com'))
  assert.ok(rule.allow[0] instanceof RegExp)
  assert.ok(rule.allow[0].test('192.0.2.1'))
  assert.ok(rule.allowMatch[0] instanceof RegExp)
  assert.ok(rule.allowMatch[0].test('gallery.example.com'))

  const bare = compileRule({ id: 'x', desc: 'y', pattern: 'z' })
  assert.equal(bare.allow, undefined)
  assert.equal(bare.allowMatch, undefined)
  assert.equal(bare.re.flags, 'gi')
})

test('compileRule：主 pattern 强制带 g（否则 matchAll 抛 TypeError）', () => {
  const rule = compileRule({ id: 'x', desc: 'y', pattern: 'leak', flags: 'i' })
  assert.ok(rule.re.flags.includes('g'))
  assert.doesNotThrow(() => [...'leak leak'.matchAll(rule.re)])
})

test('compileRule：allow/allowMatch 剥掉 g（否则 lastIndex 推进使豁免时真时假）', () => {
  const rule = compileRule({
    id: 'x',
    desc: 'y',
    pattern: 'leak',
    allow: [{ pattern: 'ok', flags: 'gi' }],
    allowMatch: [{ pattern: 'ok', flags: 'g' }],
  })
  assert.ok(!rule.allow[0].flags.includes('g'))
  assert.ok(!rule.allowMatch[0].flags.includes('g'))
  // 同一 pattern 反复 test 同一内容必须恒定
  assert.equal(rule.allow[0].test('ok'), rule.allow[0].test('ok'))
  assert.equal(rule.allowMatch[0].test('ok'), rule.allowMatch[0].test('ok'))
})

test('allow 带 g 时豁免仍对每一行稳定生效', () => {
  const root = makeRepo()
  const configPath = writeConfig(
    root,
    JSON.stringify([
      {
        id: 'probe',
        desc: 'probe rule',
        pattern: 'leak\\.example\\.com',
        flags: 'gi',
        allow: [{ pattern: '192\\.0\\.2\\.', flags: 'g' }],
      },
    ]),
  )
  const line = 'const x = "leak.example.com" // 192.0.2.1\n'
  writeSource(root, 'src/a.ts', line.repeat(4))
  const result = checkSensitiveStrings({ repoRoot: root, configPath, check: true })
  assert.equal(result.exit, 0)
  assert.deepEqual(result.findings, [])
})

test('scanFile：超长行跳过（疑似 base64 / 压缩产物）', () => {
  const root = makeRepo()
  const configPath = writeConfig(
    root,
    JSON.stringify([{ id: 'probe', desc: 'probe rule', pattern: 'leak\\.example\\.com' }]),
  )
  writeSource(root, 'src/short.ts', 'leak.example.com\n')
  writeSource(root, 'src/long.ts', `${'x'.repeat(2001)}leak.example.com\n`)
  const result = checkSensitiveStrings({ repoRoot: root, configPath, check: true })
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].file, 'src/short.ts')
})

test('collectFiles：SCAN_NAMES 收无扩展名文件、SKIP_FILES/SKIP_DIRS 跳过', () => {
  const root = makeRepo()
  writeSource(root, '.gitmodules', 'x\n')
  writeSource(root, '.npmrc', 'x\n')
  writeSource(root, 'src/a.ts', 'x\n')
  writeSource(root, 'sensitive-rules.json', '[]\n')
  writeSource(root, 'sensitive-rules.example.json', '[]\n')
  writeSource(root, 'pnpm-lock.yaml', 'x\n')
  writeSource(root, 'src/a.png', 'x\n')
  writeSource(root, 'node_modules/dep/index.js', 'x\n')
  writeSource(root, 'vendor/fork/index.ts', 'x\n')

  const names = collectFiles(root).map((f) => f.slice(root.length + 1).replace(/\\/g, '/'))
  assert.deepEqual(names.sort(), ['.gitmodules', '.npmrc', 'src/a.ts'])
})

/*---- 扫描集合来源：git 列表优先，非 git 场景回退目录遍历 ----*/

const LEAK_RULE = JSON.stringify([
  { id: 'probe', desc: 'probe rule', pattern: 'leak\\.example\\.com', flags: 'gi' },
])

/** 把临时命中串写进夹具文件，避免测试自身被扫描器命中。 */
function leakLine() {
  return 'const u = "https://leak.example.com"\n'
}

// 本机全局 excludes（~/.config/git/ignore 之类）能让探针文件在 git 模式下凭空消失，
// 真 git 用例必须把 HOME/XDG 隔离到临时根。扫描器内部的 git 调用读的是 process.env，
// 所以只能临时改写进程环境。
function withIsolatedGitEnv(root, fn) {
  const keys = [
    'HOME',
    'USERPROFILE',
    'XDG_CONFIG_HOME',
    'GIT_CONFIG_NOSYSTEM',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_SYSTEM',
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
  ]
  const saved = new Map(keys.map((key) => [key, process.env[key]]))
  process.env.HOME = root
  process.env.USERPROFILE = root
  process.env.XDG_CONFIG_HOME = join(root, 'xdg-config')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  for (const key of [
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_SYSTEM',
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
  ]) {
    delete process.env[key]
  }
  try {
    return fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('被忽略的目录不扫：.gitignore 说了算，不再靠手抄清单', { skip: !HAS_GIT }, () => {
  const root = makeRepo()
  const configPath = writeConfig(root, LEAK_RULE)
  let result
  withIsolatedGitEnv(root, () => {
    git(root, ['init'])
    writeSource(root, '.gitignore', '.tmp-probe-*/\n')
    writeSource(root, '.tmp-probe-bug/recording.md', leakLine())
    writeSource(root, 'src/a.ts', 'nothing here\n')
    result = checkSensitiveStrings({ repoRoot: root, configPath, check: true })
  })
  assert.equal(result.source, 'git')
  assert.equal(result.exit, 0)
  assert.deepEqual(result.findings, [])

  // 同一夹具用回退遍历必须能捞到：证明这条例子真在验 git 忽略语义，而不是夹具写错
  const walked = collectScanFiles(root, () => null)
  assert.equal(walked.viaGit, false)
  assert.ok(walked.files.some((f) => f.endsWith('recording.md')))
})

test('未跟踪但未被忽略的新文件仍扫，已跟踪的同样扫', { skip: !HAS_GIT }, () => {
  const root = makeRepo()
  const configPath = writeConfig(root, LEAK_RULE)
  let result
  withIsolatedGitEnv(root, () => {
    git(root, ['init'])
    writeSource(root, 'src/tracked.ts', leakLine())
    writeSource(root, 'src/untracked.ts', leakLine())
    git(root, ['add', 'src/tracked.ts'])
    result = checkSensitiveStrings({ repoRoot: root, configPath, check: true })
  })
  assert.equal(result.source, 'git')
  assert.equal(result.exit, 1)
  assert.deepEqual(result.findings.map((f) => f.file).sort(), [
    'src/tracked.ts',
    'src/untracked.ts',
  ])
})

test('非 git 场景回退到目录遍历，剪枝语义与今天一致', () => {
  const root = makeRepo()
  const configPath = writeConfig(root, LEAK_RULE)
  writeSource(root, 'src/a.ts', leakLine())
  writeSource(root, 'node_modules/dep/index.js', leakLine())

  const walked = collectScanFiles(root, () => null)
  assert.equal(walked.viaGit, false)
  assert.deepEqual(walked.files.slice().sort(), collectFiles(root).slice().sort())

  const result = checkSensitiveStrings({
    repoRoot: root,
    configPath,
    check: true,
    listGit: () => null,
  })
  assert.equal(result.source, 'walk')
  assert.equal(result.exit, 1)
  assert.deepEqual(
    result.findings.map((f) => f.file),
    ['src/a.ts'],
  )

  // 真环境（没有 git init 的临时目录）：命中照报，回退是否生效不影响可观测行为
  const ambient = checkSensitiveStrings({ repoRoot: root, configPath, check: true })
  assert.equal(ambient.exit, 1)
  assert.equal(ambient.findings[0].file, 'src/a.ts')
})

test('listGitFiles：失败与越界一律 null，成功态解析 -z 输出', () => {
  const root = makeRepo()
  const calls = []
  const run = (res) => (args, cwd) => {
    calls.push({ args, cwd })
    return res
  }

  assert.deepEqual(
    listGitFiles(root, run({ status: 0, stdout: 'a.ts\0src/b b.ts\0中文/名.md\0\0' })),
    ['a.ts', 'src/b b.ts', '中文/名.md'],
  )
  assert.deepEqual(calls[0].args, ['ls-files', '-c', '-o', '--exclude-standard', '-z'])
  assert.equal(calls[0].cwd, root)

  // -c 在冲突未解决时按 stage 重复输出同一路径
  assert.deepEqual(listGitFiles(root, run({ status: 0, stdout: 'a.ts\0a.ts\0' })), ['a.ts'])

  assert.equal(listGitFiles(root, run({ status: 128, stdout: '' })), null) // 非仓库
  assert.equal(
    listGitFiles(root, run({ status: null, stdout: null, error: new Error('ENOENT') })),
    null,
  )
  assert.equal(listGitFiles(root, run({ status: 0, stdout: null })), null) // 截断 / 异常
  assert.equal(listGitFiles(root, run({ status: 0, stdout: '../escape.ts\0' })), null)
  assert.equal(listGitFiles(root, run({ status: 0, stdout: '/etc/passwd\0' })), null)
})

test('git 模式不套 SKIP_DIRS，但目录/gitlink/已删文件会被跳过', () => {
  const root = makeRepo()
  writeSource(root, 'release/x.ts', 'x\n')
  writeSource(root, 'node_modules/y.ts', 'x\n')
  writeSource(root, 'pnpm-lock.yaml', 'x\n')
  writeSource(root, 'src/a.png', 'x\n')
  mkdirSync(join(root, 'sub'), { recursive: true })

  const { files, viaGit } = collectScanFiles(root, () => [
    'release/x.ts',
    'node_modules/y.ts',
    'sub', // 目录：submodule 在主仓只以 gitlink 出现
    'src/gone.ts', // index 里有、盘上已删
    'pnpm-lock.yaml', // SKIP_FILES
    'src/a.png', // SCAN_EXTS 之外
  ])
  assert.equal(viaGit, true)
  const rel = files.map((f) => f.slice(root.length + 1).replace(/\\/g, '/'))
  assert.deepEqual(rel.sort(), ['node_modules/y.ts', 'release/x.ts'])
})

test('金丝雀：本仓的扫描集合确实来自 git', { skip: !HAS_GIT }, () => {
  const { files, viaGit } = collectScanFiles(REPO_ROOT)
  assert.equal(viaGit, true)
  assert.ok(files.length > 1000, `scan set looks too small: ${files.length}`)
})
