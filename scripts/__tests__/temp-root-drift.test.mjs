/*---------------------------------------------------------------------------------------------
 *  Tests for scripts/lib/temp-root.mjs. Run with `node --test`.
 *
 *  两件事：
 *   1. drift —— packages/temp-root（TS）与 scripts/lib/temp-root.mjs（MJS）是刻意双实现
 *      （根目录裸 node 脚本没有构建步骤），常量必须一致，否则清理命令删的范围和运行期写的
 *      范围会对不上。
 *   2. 安全边界 —— sweep 只碰白名单前缀、只碰超时的一级子目录、绝不递归清空；体积统计
 *      不跟随 symlink（曾把 junction 指向的外部目录算进来，误报「4,484 文件 / 105 MB」）。
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TEMP_LIVE_DIR_NAMES,
  TEMP_PREFIXES,
  mkTempDir,
  sweepStaleTempDirs,
} from '../lib/temp-root.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TS_SOURCE = join(REPO_ROOT, 'packages', 'temp-root', 'src', 'index.ts')
const MJS_SOURCE = join(REPO_ROOT, 'scripts', 'lib', 'temp-root.mjs')
const HOUR = 60 * 60 * 1000

function extractArray(source, name) {
  const match = new RegExp(`export const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]`).exec(source)
  assert.ok(match, `未在源码中找到 ${name}`)
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

function extractStringConst(source, name) {
  const match = new RegExp(`const ${name}\\s*=\\s*'([^']*)'`).exec(source)
  assert.ok(match, `未在源码中找到 ${name}`)
  return match[1]
}

const tsSource = readFileSync(TS_SOURCE, 'utf8')
const mjsSource = readFileSync(MJS_SOURCE, 'utf8')

test('drift: TEMP_PREFIXES 两份实现完全一致', () => {
  const expected = extractArray(mjsSource, 'TEMP_PREFIXES')
  assert.deepEqual(extractArray(tsSource, 'TEMP_PREFIXES'), expected)
  assert.deepEqual([...TEMP_PREFIXES], expected)
})

test('drift: TEMP_LIVE_DIR_NAMES 两份实现完全一致', () => {
  const expected = extractArray(mjsSource, 'TEMP_LIVE_DIR_NAMES')
  assert.deepEqual(extractArray(tsSource, 'TEMP_LIVE_DIR_NAMES'), expected)
  assert.deepEqual([...TEMP_LIVE_DIR_NAMES], expected)
})

test('drift: 默认根算法的常量一致', () => {
  for (const name of [
    'WORKSPACE_MARKER',
    'WINDOWS_ROOT_DIR_NAME',
    'OVERRIDE_ENV',
    'RUN_ROOT_ENV',
  ]) {
    assert.equal(
      extractStringConst(tsSource, name),
      extractStringConst(mjsSource, name),
      `${name} 不一致`,
    )
  }
})

/**
 * 护栏（check-temp-root）拦得住裸 os.tmpdir()，拦不住一个没登记进 TEMP_PREFIXES 的新前缀——
 * 那种目录清理命令永远不认，只会静静堆积。所以反过来扫调用点：每个字面前缀都要能被白名单覆盖。
 */
test('drift: 全仓 mkTempDir 的字面前缀都被 TEMP_PREFIXES 覆盖', () => {
  const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-bundle', 'out', 'coverage', '.turbo'])
  const SKIP_NAME = /^\.tmp-/
  const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx)$/
  const files = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || SKIP_NAME.test(entry.name)) continue
        walk(join(dir, entry.name))
      } else if (entry.isFile() && SOURCE_EXT.test(entry.name)) {
        files.push(join(dir, entry.name))
      }
    }
  }
  for (const root of ['apps', 'packages', 'extensions', 'extensions-external', 'scripts']) {
    walk(join(REPO_ROOT, root))
  }

  const uncovered = new Map()
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/mkTempDir\(\s*'([^']+)'/g)) {
      const prefix = match[1]
      if (TEMP_PREFIXES.some((p) => prefix.startsWith(p))) continue
      if (!uncovered.has(prefix)) {
        uncovered.set(prefix, `${file.slice(REPO_ROOT.length + 1)}:${source.slice(0, match.index).split('\n').length}`)
      }
    }
  }
  assert.deepEqual(
    [...uncovered],
    [],
    '这些前缀没登记进 TEMP_PREFIXES，pnpm tmp:clean 永远收不到它们',
  )
})

// 测试要造自己的扫描根：走被测模块的 mkTempDir（前缀 ue- 在白名单内，可被清理命令回收）
// 而不是裸调 os.tmpdir()——本仓库正是不允许后者才有的这套东西。
const scratchRoots = []
function scratch() {
  const dir = mkTempDir('ue-drift-')
  scratchRoots.push(dir)
  return dir
}

function makeDir(root, name) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'f.txt'), 'x'.repeat(100))
  return dir
}

/** 把目录 mtime 推回过去。必须在目录内容写完之后调用——增删子项会刷新父目录的 mtime。 */
function age(dir, ageMs) {
  const when = new Date(Date.now() - ageMs)
  utimesSync(dir, when, when)
  return dir
}

test.after(() => {
  for (const dir of scratchRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('sweep: 只删命中前缀且超时的目录，其余一律不动', () => {
  const root = scratch()
  const oldOurs = age(makeDir(root, 'ue-old-abc123'), 48 * HOUR)
  const oldTheirs = age(makeDir(root, 'some-other-tool-abc123'), 48 * HOUR)
  const freshOurs = makeDir(root, 'ue-fresh-abc123')

  const result = sweepStaleTempDirs({ roots: [root], maxAgeMs: 24 * HOUR })

  assert.equal(existsSync(oldOurs), false, '超时的自有目录应被删除')
  assert.equal(existsSync(oldTheirs), true, '非白名单目录绝不能删')
  assert.equal(existsSync(freshOurs), true, '未超时的目录不删')
  assert.deepEqual(result.removed, [oldOurs])
})

test('sweep: dry-run 一个都不删', () => {
  const root = scratch()
  const oldOurs = age(makeDir(root, 'ue-dry-abc123'), 48 * HOUR)
  const result = sweepStaleTempDirs({ roots: [root], maxAgeMs: 24 * HOUR, dryRun: true })
  assert.equal(existsSync(oldOurs), true)
  assert.deepEqual(result.removed, [])
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].path, oldOurs)
})

test('sweep: 散文件同样按前缀 + TTL 回收（剪贴板中转文件 / p4 argfile 这类）', () => {
  const root = scratch()
  const oldFile = join(root, 'ue-fileclipboard-123-1.out.txt')
  const freshFile = join(root, 'ue-fileclipboard-123-2.out.txt')
  const otherFile = join(root, 'some-other-tool.txt')
  for (const file of [oldFile, freshFile, otherFile]) writeFileSync(file, 'x'.repeat(50))
  age(oldFile, 48 * HOUR)
  age(otherFile, 48 * HOUR)

  const result = sweepStaleTempDirs({ roots: [root], maxAgeMs: 24 * HOUR })

  assert.equal(existsSync(oldFile), false, '超时的自有散文件应被删除')
  assert.equal(existsSync(freshFile), true, '未超时的文件不删')
  assert.equal(existsSync(otherFile), true, '非白名单文件绝不能删')
  assert.deepEqual(result.removed, [oldFile])
})

test('sweep: 不递归——扫描根自身不被删，嵌套内容随命中目录整棵删除', () => {
  const root = scratch()
  const outer = makeDir(root, 'ue-outer-abc123')
  const nested = join(outer, 'inner-abc123')
  mkdirSync(nested, { recursive: true })
  age(outer, 48 * HOUR)

  sweepStaleTempDirs({ roots: [root], maxAgeMs: 24 * HOUR })

  assert.equal(existsSync(root), true, '扫描根绝不能被删')
  assert.equal(existsSync(outer), false, '超时的外层目录应被删')
  assert.equal(existsSync(nested), false, '嵌套内容随外层整棵删除是预期的')
})

test('sweep: liveRoot 下跳过活动缓存目录，旧位置同名目录仍回收', () => {
  const root = scratch()
  const live = age(makeDir(root, TEMP_LIVE_DIR_NAMES[0]), 48 * HOUR)
  const other = age(makeDir(root, 'ue-other-abc123'), 48 * HOUR)

  sweepStaleTempDirs({ roots: [root], maxAgeMs: 24 * HOUR, liveRoot: root })
  assert.equal(existsSync(live), true, '活动缓存目录在该根下必须保留')
  assert.equal(existsSync(other), false)

  const legacy = scratch()
  const orphan = age(makeDir(legacy, TEMP_LIVE_DIR_NAMES[0]), 48 * HOUR)
  sweepStaleTempDirs({ roots: [legacy], maxAgeMs: 24 * HOUR, liveRoot: root })
  assert.equal(existsSync(orphan), false, '旧位置的同名目录是孤儿，应回收')
})

test('sweep: 体积统计不跟随 symlink（曾致 junction 误报 105 MB）', () => {
  const root = scratch()
  const heavy = join(scratch(), 'heavy')
  mkdirSync(heavy, { recursive: true })
  writeFileSync(join(heavy, 'big.bin'), Buffer.alloc(2 * 1024 * 1024))

  const dir = makeDir(root, 'ues-python-abc123')
  let linked = true
  try {
    symlinkSync(heavy, join(dir, 'python'), 'junction')
  } catch {
    linked = false
  }
  age(dir, 48 * HOUR)

  const result = sweepStaleTempDirs({ roots: [root], maxAgeMs: 24 * HOUR, dryRun: true })
  assert.equal(result.candidates.length, 1, '该目录应被判定为候选（TTL 已过）')
  if (linked) {
    assert.ok(result.bytes < 512 * 1024, `体积统计应忽略链接目标，实际 ${result.bytes} 字节`)
  }
})

test('mkTempDir: 目录落在生效临时根下且唯一', () => {
  const dirs = new Set([mkTempDir('ue-drift-probe-'), mkTempDir('ue-drift-probe-')])
  assert.equal(dirs.size, 2)
  for (const dir of dirs) {
    assert.equal(existsSync(dir), true)
    rmSync(dir, { recursive: true, force: true })
  }
})
