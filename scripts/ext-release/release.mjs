#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  自动化发布 extensions-external/* 到本地市场 stage（并可选上传服务器）。
 *
 *  用法（在仓库根目录）:
 *    pnpm ext:release [-- 选项] [ext ...]
 *    node scripts/ext-release/release.mjs [选项] [ext ...]
 *
 *  流程（每个扩展）: 发现 → 增量判定 → build → package(createVsix) → gallery/publish 进 stage
 *  最后（除非 --no-upload）: gallery/upload 同步到服务器市场根。
 *
 *  「自动发现」: 扫 extensions-external/*，只处理 manifest 合法（有 publisher + engines.universe
 *  且非 private）的目录——新插件放进去即被纳入，无需改本脚本。
 *  「增量」: 若 <publisher>.<name>@<version> 已在 stage registry，则跳过 build/pack/publish
 *  （用 --force 强制重打）。位置参数可显式指定要处理的扩展（目录名或 publisher.name）。
 *
 *  连接信息与 gallery/upload.mjs 共用: UE_RELEASE_HOST/USER + UE_GALLERY_DIR；
 *  stage 目录: --stage 或 UE_GALLERY_STAGE，默认 <repo>/market-stage。
 *
 *  纯逻辑（发现/选择/增量）在 lib.mjs，便于单测。
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readRegistry } from '../gallery/lib.mjs'
import { discoverExtensions, filterIncremental, selectExtensions } from './lib.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')
const externalRoot = join(repoRoot, 'extensions-external')

const BOOL_FLAGS = new Set(['dry-run', 'no-upload', 'force', 'help'])

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      if (BOOL_FLAGS.has(key)) out[key] = true
      else {
        const next = argv[i + 1]
        if (next === undefined || next.startsWith('--')) out[key] = true
        else {
          out[key] = next
          i++
        }
      }
    } else out._.push(a)
  }
  return out
}

const c = { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', reset: '\x1b[0m' }
function die(msg) {
  console.error(`${c.red}✗ ${msg}${c.reset}`)
  process.exit(1)
}
function ok(msg) {
  console.log(`${c.green}✓ ${msg}${c.reset}`)
}
function info(msg) {
  console.log(`${c.dim}${msg}${c.reset}`)
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(
    [
      '发布 extensions-external/* 到市场 stage。',
      '',
      '选项:',
      '  --stage <dir>   市场 stage 目录（默认 <repo>/market-stage，或 UE_GALLERY_STAGE）',
      '  --force         忽略增量判定，强制重新 build/pack/publish',
      '  --no-upload     只写本地 stage，不 scp 到服务器',
      '  --dry-run       打印将执行的步骤，不实际改动',
      '  [ext ...]       只处理指定扩展（目录名或 publisher.name），默认全部合法扩展',
    ].join('\n'),
  )
  process.exit(0)
}

const stageDir = resolve(args.stage ?? process.env.UE_GALLERY_STAGE ?? join(repoRoot, 'market-stage'))
const dryRun = args['dry-run'] ?? false
const force = args.force ?? false
const doUpload = !(args['no-upload'] ?? false)

function run(cmd, cmdArgs, cwd) {
  const printable = `${cmd} ${cmdArgs.join(' ')}`
  if (dryRun) {
    info(`  [dry-run] ${printable}${cwd ? `  (cwd=${cwd})` : ''}`)
    return
  }
  const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: cwd ?? repoRoot, shell: true })
  if (res.error) die(`执行失败: ${printable}\n  ${res.error.message}`)
  if (res.status !== 0) die(`命令返回非零退出码 (${res.status}): ${printable}`)
}

// --- 主流程 ---------------------------------------------------------------

console.log(`\n📦 扫描 ${externalRoot}`)
const { eligible, skipped } = discoverExtensions(externalRoot)
for (const s of skipped) info(`  skip ${s.dir} (${s.reason})`)
if (eligible.length === 0) die('extensions-external 下没有可发布的扩展')

const sel = selectExtensions(eligible, args._)
if (sel.error) die(sel.error)

const registry = readRegistry(stageDir)
const { toPublish, skipped: unchanged } = filterIncremental(registry, sel.selected, force)
for (const ext of unchanged) info(`  skip ${ext.id}@${ext.version} (registry 已有，用 --force 重发)`)

if (toPublish.length === 0) {
  ok('没有需要发布的扩展（全部已是最新，或用 --force 强制）')
  process.exit(0)
}

console.log(`\n待发布 (${toPublish.length}): ${toPublish.map((e) => `${e.id}@${e.version}`).join(', ')}`)

const vsixPaths = []
for (const ext of toPublish) {
  console.log(`\n── ${ext.id}@${ext.version} ──`)
  run('npm', ['run', 'build'], ext.extDir)
  run('npm', ['run', 'package'], ext.extDir)
  const vsixPath = join(ext.extDir, `${ext.id}-${ext.version}.vsix`)
  if (!dryRun && !existsSync(vsixPath)) die(`打包后找不到 VSIX: ${vsixPath}`)
  vsixPaths.push(vsixPath)
}

console.log(`\n📥 发布进 stage: ${stageDir}`)
run('node', [join(repoRoot, 'scripts/gallery/publish.mjs'), '--stage', stageDir, ...vsixPaths])

if (!doUpload) {
  ok(`已发布 ${toPublish.length} 个扩展到本地 stage（--no-upload，未同步服务器）`)
  info(
    `  同步命令: node scripts/gallery/upload.mjs --stage ${stageDir} --host <IP> --user <user> --dir <市场根>`,
  )
  process.exit(0)
}

console.log(`\n🚀 上传到服务器市场根`)
run('node', [
  join(repoRoot, 'scripts/gallery/upload.mjs'),
  '--stage',
  stageDir,
  ...(dryRun ? ['--dry-run'] : []),
])

ok(`发布完成: ${toPublish.map((e) => `${e.id}@${e.version}`).join(', ')}`)
