/*---------------------------------------------------------------------------------------------
 *  scripts/lib/env.mjs 单测：dotenv 解析子集 / mode 解析 / 四层文件加载优先级。
 *  全程使用临时目录与独立 env 对象，绝不触碰真实 process.env。
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadEnv, parseEnvText, resolveMode } from '../env.mjs'

test('parseEnvText: 空行与注释行被跳过', () => {
  assert.deepEqual(parseEnvText('\n  \n# comment\n   # indented comment\nA=1\n'), { A: '1' })
})

test('parseEnvText: export 前缀被剥掉', () => {
  assert.deepEqual(parseEnvText('export A=1\nexport B=two\n'), { A: '1', B: 'two' })
})

test('parseEnvText: 单引号取字面内容不做转义', () => {
  assert.deepEqual(parseEnvText("A='hello \\n world'"), { A: 'hello \\n world' })
})

test('parseEnvText: 双引号处理 \\n \\r \\t \\\\ 转义', () => {
  assert.deepEqual(parseEnvText('A="a\\nb\\rc\\td\\\\e"'), { A: 'a\nb\rc\td\\e' })
})

test('parseEnvText: 值含 = 按第一个 = 切分', () => {
  assert.deepEqual(parseEnvText('A=key=value=tail'), { A: 'key=value=tail' })
})

test('parseEnvText: CRLF 行尾兼容', () => {
  assert.deepEqual(parseEnvText('A=1\r\nB=2\r\n'), { A: '1', B: '2' })
})

test('parseEnvText: 空值得到空字符串', () => {
  assert.deepEqual(parseEnvText('A=\nB=  \n'), { A: '', B: '' })
})

test('parseEnvText: 非法 key 与无等号的行被跳过', () => {
  assert.deepEqual(parseEnvText('1A=x\nA-B=y\nJUST_A_LINE\nA=1\n'), { A: '1' })
})

test('parseEnvText: 裸值保留行尾 #（固化行为，不剥注释）', () => {
  assert.deepEqual(parseEnvText('A=value # not a comment'), { A: 'value # not a comment' })
})

test('parseEnvText: key 两侧空白被 trim', () => {
  assert.deepEqual(parseEnvText('  A  =  spaced  '), { A: 'spaced' })
})

test('resolveMode: --env <mode> 空格写法', () => {
  assert.equal(resolveMode(['--env', 'prod'], {}), 'prod')
})

test('resolveMode: --env=prod 等号写法', () => {
  assert.equal(resolveMode(['--env=prod'], {}), 'prod')
})

test('resolveMode: 两种写法同时出现取最后一次', () => {
  assert.equal(resolveMode(['--env', 'dev', '--env=prod'], {}), 'prod')
})

test('resolveMode: UE_ENV 回退', () => {
  assert.equal(resolveMode([], { UE_ENV: 'staging' }), 'staging')
})

test('resolveMode: 默认 dev', () => {
  assert.equal(resolveMode([], {}), 'dev')
})

test('resolveMode: flag 压过 UE_ENV', () => {
  assert.equal(resolveMode(['--env', 'prod'], { UE_ENV: 'dev' }), 'prod')
})

test('resolveMode: 非法 mode 抛错并带上非法值', () => {
  for (const bad of ['../x', 'PROD', '']) {
    assert.throws(() => resolveMode(['--env', bad], {}), new RegExp(`"${bad}"`))
  }
  assert.throws(() => resolveMode([], { UE_ENV: 'a/b' }), /"a\/b"/)
})

function makeTmpEnvDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ue-env-loader-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('loadEnv: 四层优先级 .env.<mode>.local > .env.<mode> > .env.local > .env', (t) => {
  const dir = makeTmpEnvDir(t)
  writeFileSync(join(dir, '.env'), 'A=base\nB=base\nC=base\nD=base\n')
  writeFileSync(join(dir, '.env.local'), 'A=local\nB=local\nC=local\n')
  writeFileSync(join(dir, '.env.prod'), 'A=prod\nB=prod\n')
  writeFileSync(join(dir, '.env.prod.local'), 'A=prod-local\n')
  const env = {}
  const result = loadEnv({ cwd: dir, argv: ['--env', 'prod'], env, quiet: true })
  assert.deepEqual(env, { A: 'prod-local', B: 'prod', C: 'local', D: 'base' })
  assert.equal(result.mode, 'prod')
  assert.equal(result.files.length, 4)
})

test('loadEnv: 已存在于 env 的 key（含空字符串值）不被覆盖', (t) => {
  const dir = makeTmpEnvDir(t)
  writeFileSync(join(dir, '.env'), 'A=file\nB=file\nC=file\n')
  const env = { A: 'shell', B: '' }
  loadEnv({ cwd: dir, argv: [], env, quiet: true })
  assert.deepEqual(env, { A: 'shell', B: '', C: 'file' })
})

test('loadEnv: 缺失文件跳过不报错，files 只含存在的文件', (t) => {
  const dir = makeTmpEnvDir(t)
  writeFileSync(join(dir, '.env'), 'A=1\n')
  const result = loadEnv({ cwd: dir, argv: [], env: {}, quiet: true })
  assert.deepEqual(result.files, [join(dir, '.env')])
})

test('loadEnv: --env prod 读 .env.prod 而非 .env.dev', (t) => {
  const dir = makeTmpEnvDir(t)
  writeFileSync(join(dir, '.env.dev'), 'A=dev\n')
  writeFileSync(join(dir, '.env.prod'), 'A=prod\n')
  const env = {}
  loadEnv({ cwd: dir, argv: ['--env', 'prod'], env, quiet: true })
  assert.equal(env.A, 'prod')
})

test('loadEnv: quiet: true 不打日志且正常返回', (t) => {
  const dir = makeTmpEnvDir(t)
  const result = loadEnv({ cwd: dir, argv: [], env: {}, quiet: true })
  assert.deepEqual(result, { mode: 'dev', files: [] })
})

test('loadEnv: 无文件命中时也不报错', (t) => {
  const dir = makeTmpEnvDir(t)
  const result = loadEnv({ cwd: dir, argv: [], env: {} })
  assert.equal(result.mode, 'dev')
  assert.deepEqual(result.files, [])
})
