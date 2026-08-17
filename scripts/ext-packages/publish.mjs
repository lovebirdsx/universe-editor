#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  一键发布外部 SDK 五件套（@universe-editor/*）到公开 npm，并同步内网 tarball。
 *
 *  用法（在仓库根目录）:
 *    pnpm ext-packages:publish [-- 选项] [pkg ...]
 *    node scripts/ext-packages/publish.mjs [选项] [pkg ...]
 *
 *  流程: preflight → build → pack 内容检查 → 拓扑序 publish → 协议替换验证
 *        → git commit/tag/push → gallery 内网同步（--no-gallery 跳过）。
 *
 *  「版本由开发者提前 bump」: 本脚本不 bump 版本；preflight 校验本地版本高于 npm 已发布版
 *  （相同则增量跳过，更低则报错）。extension-api 的 bump 必须先走 COMPATIBILITY.md 流程。
 *  「白名单 commit」: SDK 目录内未提交的版本改动会被脚本 commit（chore(release): publish ...）；
 *  目录外的改动（extensions/ 的 engines.universe 同步等）须先自行 commit，否则 preflight 拒绝。
 *  「幂等自愈」: npm 发布成功但 tag/push/gallery 中断时重跑即可收敛——已发布版本增量跳过，
 *  tag 缺失补打，gallery 重同步。
 *
 *  纯逻辑（选择/拓扑/计划/清单校验）在 lib.mjs，便于单测。
 *--------------------------------------------------------------------------------------------*/

import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from '../lib/env.mjs'
import { SDK_PACKAGE_DIRS } from '../lib/sdk-packages.mjs'
import {
  apiVersionConstantMatches,
  assessExternalDeps,
  checkPackListing,
  checkVersionConstants,
  galleryConfigIssue,
  hasCompatibilityEntry,
  loadPackageManifests,
  parsePackListing,
  planExternalDepQueries,
  planPublish,
  selectPackages,
  tagName,
  topologicalLevels,
  topologicalOrder,
  unexpectedChanges,
  verifyPublishedDeps,
} from './lib.mjs'

const { mode: envMode, explicit: envExplicit } = loadEnv()

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

const BOOL_OPTIONS = new Set(['dry-run', 'no-gallery', 'no-push', 'allow-non-main', 'help'])
const VALUE_OPTIONS = new Set(['registry', 'stage', 'env'])

function camelCaseFlag(flag) {
  return flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}

export function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    if (raw === '--') continue // pnpm run 会把分隔符 `--` 透传给脚本
    if (!raw.startsWith('--')) {
      out._.push(raw)
      continue
    }
    const name = raw.slice(2)
    const key = camelCaseFlag(name)
    if (BOOL_OPTIONS.has(name)) {
      out[key] = true
      continue
    }
    if (!VALUE_OPTIONS.has(name)) throw new Error(`无法识别参数: ${raw}`)
    const value = argv[i + 1]
    if (!value || value.startsWith('--')) throw new Error(`缺少 ${raw} 的值`)
    out[key] = value
    i++
  }
  return out
}

const c = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
}
function die(msg) {
  console.error(`${c.red}✗ ${msg}${c.reset}`)
  process.exit(1)
}
function ok(msg) {
  console.log(`${c.green}✓ ${msg}${c.reset}`)
}
function warn(msg) {
  console.warn(`${c.yellow}⚠ ${msg}${c.reset}`)
}
function info(msg) {
  console.log(`${c.dim}${msg}${c.reset}`)
}

function shouldUseShell(command) {
  return process.platform === 'win32' && (command === 'pnpm' || command === 'npm')
}

function printableCommand(command, args) {
  return [command, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')
}

function run(command, args, { cwd, dryRun } = {}) {
  const printable = printableCommand(command, args)
  if (dryRun) {
    info(`  [dry-run] ${printable}`)
    return
  }
  const result = spawnSync(command, args, {
    cwd: cwd ?? repoRoot,
    stdio: 'inherit',
    shell: shouldUseShell(command),
  })
  if (result.error) die(`执行失败: ${printable}\n  ${result.error.message}`)
  if (result.status !== 0) die(`命令返回非零退出码 (${result.status}): ${printable}`)
}

function git(args) {
  // trimEnd 而非 trim：status --porcelain 多行输出首行的前导状态空格必须保留
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trimEnd()
}

function gitMaybe(args) {
  try {
    return git(args)
  } catch {
    return ''
  }
}

function gitExitCode(args) {
  return spawnSync('git', args, { cwd: repoRoot, stdio: 'ignore' }).status ?? 1
}

function tagExists(tag) {
  return Boolean(gitMaybe(['rev-parse', '-q', '--verify', `refs/tags/${tag}`]))
}

/** 异步执行命令并捕获输出（可并发环节用）；串行且需直连终端的环节仍用 run()。 */
function spawnAsync(command, args, { cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: cwd ?? repoRoot,
      shell: shouldUseShell(command),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (error) => resolve({ ok: false, status: null, stdout, stderr, error }))
    child.on('close', (status) => resolve({ ok: status === 0, status, stdout, stderr }))
  })
}

/** 执行 npm 命令并捕获输出。registry 一律显式透传，不依赖全局 .npmrc。 */
function npmRun(args, registry) {
  return spawnAsync('npm', [...args, '--registry', registry])
}

function isE404(res) {
  return res.stderr?.includes('E404')
}

/** npm 上该包的最新版本；从未发布返回 null。 */
async function npmLatestVersion(name, registry) {
  const res = await npmRun(['view', name, 'version'], registry)
  if (res.ok) return res.stdout.trim()
  if (isE404(res)) return null
  die(`查询 npm 失败: npm view ${name} version\n  ${(res.stderr ?? '').trim()}`)
}

/** 精确版本是否已在 npm 上：'published' | 'missing'。 */
async function npmVersionPublished(name, version, registry) {
  const res = await npmRun(['view', `${name}@${version}`, 'version'], registry)
  if (res.ok) return 'published'
  if (isE404(res)) return 'missing'
  die(`查询 npm 失败: npm view ${name}@${version} version\n  ${(res.stderr ?? '').trim()}`)
}

/** 发布后核对 npm 上依赖表：无 workspace:/catalog: 残留、互赖为精确版本。返回 { type, message }。 */
async function verifyPublished(p, workspaceVersions, registry) {
  const res = await npmRun(['view', `${p.name}@${p.version}`, 'dependencies', '--json'], registry)
  if (!res.ok) return { type: 'warning', message: `${p.name}: 协议替换验证查询失败: ${(res.stderr ?? '').trim()}` }
  let deps = {}
  const text = res.stdout.trim()
  if (text && text !== 'undefined') {
    try {
      deps = JSON.parse(text)
    } catch {
      return { type: 'warning', message: `${p.name}: 依赖表 JSON 解析失败: ${text}` }
    }
  }
  const depErrors = verifyPublishedDeps(deps, workspaceVersions)
  if (depErrors.length > 0) {
    return { type: 'warning', message: `${p.name} 依赖协议异常:\n${depErrors.map((e) => `  - ${e}`).join('\n')}` }
  }
  return { type: 'ok', message: `${p.name} 依赖协议已替换为真实版本` }
}

function assertUpToDateWithUpstream() {
  const upstream = gitMaybe(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  if (!upstream) die('当前分支没有 upstream，无法确认是否与远端同步')
  const local = git(['rev-parse', 'HEAD'])
  const remote = git(['rev-parse', '@{u}'])
  if (local === remote) return
  // 发布流程自身产生未 push 的 commit；push 失败重跑时本地领先属正常状态，只要远端是本地祖先就继续
  if (gitExitCode(['merge-base', '--is-ancestor', remote, local]) === 0) {
    warn(`本地已领先 ${upstream}（存在未推送的发布提交），继续`)
    return
  }
  die(`当前分支与 ${upstream} 不同步，请先 pull/rebase 或 push 后再发布`)
}

function assertGalleryConfig() {
  const issue = galleryConfigIssue({
    env: process.env,
    mode: envMode,
    explicit: envExplicit,
    envFileNames: readdirSync(repoRoot),
  })
  if (issue) die(issue)
}

async function preflight(args, all, selected, registry) {
  const dryRun = Boolean(args.dryRun)

  // 1) 工作区白名单：SDK 目录内改动随发布 commit，目录外改动必须先自行处理
  const statusLines = git(['status', '--porcelain']).split(/\r?\n/).filter(Boolean)
  const outside = unexpectedChanges(statusLines, SDK_PACKAGE_DIRS)
  if (outside.length > 0) {
    const msg =
      `工作区在 SDK 目录外有未提交改动（extensions/ 的 engines.universe 同步等请先单独 commit）:\n` +
      outside.join('\n')
    if (dryRun) warn(`预检: ${msg}`)
    else die(msg)
  }
  const inside = statusLines.filter((l) => unexpectedChanges([l], SDK_PACKAGE_DIRS).length === 0)
  if (inside.length > 0) info(`SDK 目录内改动（将随发布 commit）:\n${inside.join('\n')}`)

  // 2) 分支
  const branch = git(['branch', '--show-current'])
  if (branch !== 'main' && !args.allowNonMain) {
    die(`当前分支是 ${branch || '(detached)'}，发布默认只允许在 main 上执行（--allow-non-main 绕开）`)
  }

  // 3/4/5/6) 一批并发只读网络查询：fetch tags、npm 登录态、各包最新版本、依赖完整性（互不依赖）
  const sdkVersionMap = Object.fromEntries(all.map((p) => [p.shortName, p.version]))
  const { queries, errors: planErrors } = planExternalDepQueries(selected, sdkVersionMap)
  const [fetchRes, who, latestEntries, queryEntries] = await Promise.all([
    dryRun ? Promise.resolve({ ok: true, stderr: '' }) : spawnAsync('git', ['fetch', '--tags', 'origin']),
    npmRun(['whoami'], registry),
    Promise.all(selected.map(async (p) => [p.shortName, await npmLatestVersion(p.name, registry)])),
    Promise.all(
      queries.map(async (q) => [
        `${q.depName}@${q.targetVersion}`,
        await npmVersionPublished(q.depName, q.targetVersion, registry),
      ]),
    ),
  ])
  if (!dryRun && !fetchRes.ok) die(`git fetch --tags origin 失败:\n  ${(fetchRes.stderr ?? '').trim()}`)
  if (!who.ok) {
    die(`未登录 npm（${registry}）: ${(who.stderr ?? '').trim()}\n  先执行 npm login --registry ${registry}`)
  }
  ok(`npm 登录: ${who.stdout.trim()}（${registry}）`)

  // upstream 同步（依赖 fetch 完成）
  assertUpToDateWithUpstream()

  // 5) 版本计划：本地版本必须高于 npm 已发布版
  const publishedVersions = Object.fromEntries(latestEntries)
  let plan
  try {
    plan = planPublish(selected, publishedVersions)
  } catch (error) {
    die(error.message)
  }

  // 6) 依赖完整性：集合外的 workspace 依赖必须已在 npm 发布，否则发布会指向悬空版本
  const depErrors = [...planErrors, ...assessExternalDeps(queries, Object.fromEntries(queryEntries))]
  if (depErrors.length > 0) {
    die(`依赖完整性检查失败:\n${depErrors.map((e) => `  - ${e}`).join('\n')}`)
  }

  // 7) tag 与 npm 事实一致性：npm 上没有该版本但 tag 已存在属人为异常
  for (const p of plan.toPublish) {
    const t = tagName(p.shortName, p.version)
    if (tagExists(t)) die(`git tag ${t} 已存在但 npm 上无该版本，tag 与 npm 事实冲突，请人工排查`)
  }

  // 8) extension-api 专项：破坏性变更流程必须走完
  const api = selected.find((p) => p.shortName === 'extension-api')
  if (api && plan.toPublish.includes(api)) {
    const compatText = readFileSync(join(repoRoot, api.dir, 'COMPATIBILITY.md'), 'utf8')
    if (!hasCompatibilityEntry(compatText, api.version)) {
      die(`packages/extension-api/COMPATIBILITY.md 缺少 ${api.version} 的变更记录；破坏性变更流程未走完，禁止发布`)
    }
    const indexText = readFileSync(join(repoRoot, api.dir, 'src', 'index.ts'), 'utf8')
    if (!apiVersionConstantMatches(indexText, api.version)) {
      die(`packages/extension-api/src/index.ts 的 export const version 与 package.json（${api.version}）不一致`)
    }
  }

  // 9) 版本常量同步（create-extension/uex 注入的 SDK 版本）
  const sdkVersionsText = readFileSync(join(repoRoot, 'packages/create-extension/src/sdkVersions.ts'), 'utf8')
  const sdkVersionText = readFileSync(join(repoRoot, 'packages/uex/src/lib/sdkVersion.ts'), 'utf8')
  const constErrors = checkVersionConstants({
    sdkVersionsText,
    sdkVersionText,
    apiVersion: plan.toPublish.find((p) => p.shortName === 'extension-api')?.version ?? null,
    uexVersion: plan.toPublish.find((p) => p.shortName === 'uex')?.version ?? null,
  })
  if (constErrors.length > 0) {
    die(`版本常量未同步:\n${constErrors.map((e) => `  - ${e}`).join('\n')}`)
  }

  // 10) 内网同步配置
  if (!args.noGallery) assertGalleryConfig()

  return plan
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    die(error.message)
  }
  if (args.help) {
    console.log(
      [
        '发布扩展 SDK 五件套到 npm（@universe-editor/*）并同步内网 tarball。',
        '',
        '选项:',
        '  --dry-run        只读检查照跑，写操作只打印 [dry-run]',
        '  --no-gallery     跳过内网 pack + scp 同步',
        '  --no-push        跳过 git push（本地验证用；不带该旗标重跑可补推收敛）',
        '  --allow-non-main 允许在非 main 分支发布（本地验证用）',
        '  --registry <url> npm registry（默认 https://registry.npmjs.org）',
        '  --stage <dir>    市场 stage 目录（默认 UE_GALLERY_STAGE 或 <repo>/market-stage）',
        '  --env <mode>     .env 分层加载模式（透传 loadEnv）',
        '  [pkg ...]        只发布指定包（目录名或完整包名），默认全部五件套',
        '',
        '版本需开发者提前 bump（extension-api 必须先走 COMPATIBILITY.md 流程）；',
        'SDK 目录内未提交改动会被脚本 commit，目录外改动请先自行提交。',
      ].join('\n'),
    )
    process.exit(0)
  }

  const dryRun = Boolean(args.dryRun)
  const registry = args.registry ?? DEFAULT_REGISTRY
  const stageDir = resolve(args.stage ?? process.env.UE_GALLERY_STAGE ?? join(repoRoot, 'market-stage'))

  const all = loadPackageManifests(repoRoot, SDK_PACKAGE_DIRS)
  const sel = selectPackages(all, args._)
  if (sel.error) die(sel.error)
  const topo = topologicalOrder(sel.selected)
  if (topo.error) die(topo.error)

  console.log(`\n发布 SDK 到 ${registry}${dryRun ? '（dry-run）' : ''}`)
  console.log(`范围: ${sel.selected.map((p) => `${p.name}@${p.version}`).join(', ')}`)
  console.log('')

  const { toPublish, skipped } = await preflight(args, all, sel.selected, registry)
  const toPublishOrdered = topo.order.filter((p) => toPublish.includes(p))
  for (const p of skipped) info(`  skip ${p.name}@${p.version}（npm 已有，增量跳过）`)

  const warnings = []
  if (toPublish.length === 0) {
    ok('npm 段: 全部已发布（增量跳过）；继续 git/gallery 段收敛半状态')
  } else {
    console.log(`\n待发布 (${toPublish.length}): ${toPublish.map((p) => `${p.name}@${p.version}`).join(', ')}`)

    // build（`...` 后缀连同 workspace 依赖一起构建）
    run('pnpm', [...toPublishOrdered.flatMap((p) => ['--filter', `${p.name}...`]), 'build'], { dryRun })
    if (toPublish.some((p) => p.shortName === 'extension-api')) {
      run('pnpm', ['--filter', '@universe-editor/extension-api', 'test'], { dryRun })
    }

    // pack 内容检查（dry-run 下 dist 未重建，检查结果不可信，跳过）；并行执行、按拓扑序回显
    if (dryRun) {
      info('  [dry-run] 跳过 pack 内容检查（dist 未重建）')
    } else {
      const packResults = await Promise.all(
        toPublishOrdered.map(async (p) => ({
          p,
          res: await spawnAsync('pnpm', ['pack', '--dry-run'], { cwd: join(repoRoot, p.dir) }),
        })),
      )
      for (const { p, res } of packResults) {
        const fail = (msg) => {
          if (res.stdout) process.stdout.write(res.stdout)
          if (res.stderr) process.stderr.write(res.stderr)
          die(msg)
        }
        if (!res.ok) fail(`pnpm pack --dry-run 非零退出 (${res.status}): ${p.name}`)
        const parsed = parsePackListing(`${res.stdout}\n${res.stderr}`)
        if (parsed.error) fail(`${p.name}: ${parsed.error}`)
        const errors = checkPackListing(parsed.files, {
          isBin: Boolean(p.manifest.bin),
          hasTemplates: Boolean(p.manifest.files?.includes('templates')),
        })
        if (errors.length > 0) {
          fail(`${p.name} pack 内容检查失败:\n${errors.map((e) => `  - ${e}`).join('\n')}`)
        }
        ok(`${p.name} pack 内容检查通过（${parsed.files.length} 个文件）`)
      }
    }

    // 发布（拓扑分层：层内并发、层间串行）+ 协议替换验证；层内结果按序回显
    const workspaceVersions = Object.fromEntries(all.map((p) => [p.name, p.version]))
    const { levels } = topologicalLevels(toPublishOrdered)
    const publishCommand = (p) => ['--filter', p.name, 'publish', '--no-git-checks', '--registry', registry]
    for (const level of levels) {
      const results = await Promise.all(
        level.map(async (p) => {
          if (dryRun) return { p }
          const pub = await spawnAsync('pnpm', publishCommand(p))
          if (!pub.ok) return { p, pub }
          return { p, pub, verdict: await verifyPublished(p, workspaceVersions, registry) }
        }),
      )
      for (const { p, pub, verdict } of results) {
        console.log(`\n── 发布 ${p.name}@${p.version} ──`)
        if (dryRun) {
          info(`  [dry-run] ${printableCommand('pnpm', publishCommand(p))}`)
          continue
        }
        if (pub.stdout) process.stdout.write(pub.stdout)
        if (pub.stderr) process.stderr.write(pub.stderr)
        if (!pub.ok) die(`pnpm publish 非零退出 (${pub.status}): ${p.name}`)
        if (verdict.type === 'warning') warnings.push(verdict.message)
        else ok(verdict.message)
      }
    }
  }

  // git commit + tag + push（toPublish 为空也执行，补打 tag / 重推收敛半状态）
  const changed = git(['status', '--porcelain', '--', ...SDK_PACKAGE_DIRS])
  if (changed) {
    run('git', ['add', ...SDK_PACKAGE_DIRS], { dryRun })
    const msg = `chore(release): publish ${toPublish.map((p) => tagName(p.shortName, p.version)).join(' ')}`
    run('git', ['commit', '-m', msg], { dryRun })
  } else {
    info('提交: SDK 目录无改动，跳过 commit')
  }
  for (const p of sel.selected) {
    const t = tagName(p.shortName, p.version)
    if (tagExists(t)) {
      info(`  tag ${t} 已存在，跳过`)
      continue
    }
    run('git', ['tag', '-a', t, '-m', t], { dryRun })
    ok(`tag ${t} 已创建`)
  }
  if (!args.noPush) {
    const refs = ['HEAD:main', ...sel.selected.map((p) => tagName(p.shortName, p.version))]
    run('git', ['push', 'origin', ...refs], { dryRun })
  } else {
    info('  --no-push：跳过 push，重跑本命令（不带该旗标）可补推收敛')
  }

  // gallery 内网同步
  if (!args.noGallery) {
    const galleryArgs = ['scripts/gallery/publish-sdk.mjs', '--stage', stageDir]
    run(process.execPath, dryRun ? [...galleryArgs, '--dry-run'] : galleryArgs, { dryRun })
    if (existsSync(join(stageDir, 'gallery', 'registry.json'))) {
      run(process.execPath, ['scripts/gallery/upload.mjs', '--stage', stageDir, ...(dryRun ? ['--dry-run'] : [])], {
        dryRun,
      })
    } else {
      warn(`stage 无 gallery/registry.json，跳过上传（市场未初始化）；tarball 已就绪，可手动 scp sdk/**`)
    }
  }

  if (warnings.length > 0) {
    warn(`发布完成，但存在 ${warnings.length} 项警告（npm 已是既成事实，请人工核对）:`)
    for (const w of warnings) console.warn(w)
  } else {
    ok('发布完成')
  }
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) await main()
