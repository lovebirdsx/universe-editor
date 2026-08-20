#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  校验内置插件（extensions/*）的 engines.universe 与 App 版本精确耦合。
 *
 *  单一真相：apps/editor/package.json 的 version。期望表达式取 major.minor、patch 固定 0
 *  （例如 0.13.0 → ^0.13.0）。内置插件随 App 同仓发版，engines.universe 必须严格等于该表达式。
 *
 *  用法:
 *    pnpm builtin-engines:check   （或 node scripts/check-builtin-extensions-engines.mjs）
 *    pnpm builtin-engines:fix     （或 node scripts/check-builtin-extensions-engines.mjs --fix）
 *
 *  幂等：内容没变化不写盘，避免无谓 mtime 变化。路径解析基于本文件位置（import.meta.url），
 *  不依赖 CWD；遍历 extensions/ 走 node:fs，不依赖 shell glob 展开（win32 下参数安全）。
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, writeFileSync, existsSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const defaultRepoRoot = resolve(__dirname, '..')

function readJson(absPath) {
  return JSON.parse(readFileSync(absPath, 'utf8'))
}

/** App 版本 X.Y.Z → engines 期望表达式 ^X.Y.0。 */
export function computeExpectedEngine(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) throw new Error(`App 版本必须是 X.Y.Z: ${version}`)
  return `^${match[1]}.${match[2]}.0`
}

/** extensions/ 下含 package.json 的直接子目录（不含 extensions-external/，其不在 extensions/ 下）。 */
export function listBuiltinExtensionManifests(repoRoot) {
  const dir = join(repoRoot, 'extensions')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const rel = `extensions/${entry.name}`
      return { name: entry.name, rel, manifestPath: join(dir, entry.name, 'package.json') }
    })
    .filter((m) => existsSync(m.manifestPath))
    .sort((a, b) => a.rel.localeCompare(b.rel))
}

/**
 * 原地改写 engines.universe 的取值，只替换该行的字符串字面量，保留其余全部格式
 * （manifest 可能是单行紧凑数组，全量重序列化会引入大量噪音）。无 universe 键时
 * 兜底走整对象重序列化（内置插件当前均含该键，正常不会走到）。
 */
export function patchEnginesUniverse(content, expected) {
  const re = /("universe"\s*:\s*)"[^"]*"/
  if (re.test(content)) return content.replace(re, (_, head) => `${head}"${expected}"`)
  const pkg = JSON.parse(content)
  pkg.engines = pkg.engines ?? {}
  pkg.engines.universe = expected
  return JSON.stringify(pkg, null, 2) + '\n'
}

/**
 * 读取 App 版本、计算期望表达式、校验/修复每个内置插件的 engines.universe。
 * 返回 { expected, mismatches, updated }：
 *   - mismatches: 当前值 !== 期望值 的插件（fix 模式下即「本次已修复」的集合）
 *   - updated: 实际写盘的 manifest 相对路径（fix 模式且内容有变化才计入）
 */
export function checkBuiltinExtensionsEngines({ repoRoot = defaultRepoRoot, fix = false } = {}) {
  const appPkg = readJson(join(repoRoot, 'apps/editor/package.json'))
  const expected = computeExpectedEngine(appPkg.version)

  const mismatches = []
  const updated = []
  for (const { rel, manifestPath } of listBuiltinExtensionManifests(repoRoot)) {
    const content = readFileSync(manifestPath, 'utf8')
    const found = JSON.parse(content).engines?.universe
    if (found === expected) continue
    mismatches.push({ rel, found })
    if (!fix) continue
    const next = patchEnginesUniverse(content, expected)
    if (next !== content) {
      writeFileSync(manifestPath, next)
      updated.push(rel)
    }
  }
  return { expected, mismatches, updated }
}

function main() {
  const fix = process.argv.includes('--fix')
  const { expected, mismatches, updated } = checkBuiltinExtensionsEngines({ fix })

  if (fix) {
    for (const rel of updated) console.log(`builtin-engines: 已更新 ${rel} → ${expected}`)
    if (updated.length === 0) console.log('builtin-engines: 已是最新，无文件更新')
    process.exit(0)
  }

  if (mismatches.length > 0) {
    console.error(
      `builtin-engines: ${mismatches.length} 个内置插件 engines.universe 与 App 版本不符（期望 ${expected}）:`,
    )
    for (const { rel, found } of mismatches) console.error(`  - ${rel}: 当前 ${found ?? '(缺失)'}`)
    console.error('运行 pnpm builtin-engines:fix 修复。')
    process.exit(1)
  }

  console.log(`builtin-engines: ${listBuiltinExtensionManifests(defaultRepoRoot).length} 个内置插件 engines.universe = ${expected}`)
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main()
}
