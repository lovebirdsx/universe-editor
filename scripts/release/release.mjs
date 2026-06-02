#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Universe Editor release orchestrator.
 *
 *  This script keeps the mutable release steps in one place:
 *  version bump -> release notes -> commit -> checks -> package -> tag -> push -> upload.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')
const editorPackageJson = join(repoRoot, 'apps/editor/package.json')
const releaseNotesJson = join(repoRoot, 'apps/editor/resources/release-notes.json')
const releaseDir = join(repoRoot, 'apps/editor/release')

const BOOL_OPTIONS = new Set([
  'dry-run',
  'no-push',
  'no-upload',
  'upload-only',
  'resume',
  'skip-check',
  'e2e',
  'skip-e2e',
  'allow-non-main',
])

const VALUE_OPTIONS = new Set([
  'version',
  'bump',
  'package-script',
  'host',
  'user',
  'dir',
  'port',
  'key',
  'remote-os',
])

function camelCaseFlag(flag) {
  return flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}

export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    if (!raw.startsWith('--')) throw new Error(`无法识别参数: ${raw}`)
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

function die(message) {
  console.error(`\x1b[31m✗ ${message}\x1b[0m`)
  process.exit(1)
}

function log(message = '') {
  console.log(message)
}

export function commandName(command) {
  return command
}

export function shouldUseShell(command) {
  return process.platform === 'win32' && command === 'pnpm'
}

function printableCommand(command, args) {
  return [command, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')
}

function run(command, args, options) {
  const cwd = options?.cwd ?? repoRoot
  const dryRun = options?.dryRun ?? false
  const printable = printableCommand(command, args)
  if (dryRun) {
    log(`  [dry-run] ${printable}`)
    return
  }
  const result = spawnSync(commandName(command), args, {
    cwd,
    stdio: 'inherit',
    shell: shouldUseShell(command),
  })
  if (result.error) die(`执行失败: ${printable}\n  ${result.error.message}`)
  if (result.status !== 0) die(`命令返回非零退出码 (${result.status}): ${printable}`)
}

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}

function gitMaybe(args) {
  try {
    return git(args)
  } catch {
    return ''
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, value, dryRun) {
  if (dryRun) {
    log(`  [dry-run] write ${path}`)
    return
  }
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) throw new Error(`版本号必须是 X.Y.Z: ${version}`)
  return match.slice(1).map((n) => Number(n))
}

export function compareVersions(a, b) {
  const av = parseSemver(a)
  const bv = parseSemver(b)
  for (let i = 0; i < av.length; i++) {
    if (av[i] > bv[i]) return 1
    if (av[i] < bv[i]) return -1
  }
  return 0
}

export function bumpVersion(version, bump) {
  const [major, minor, patch] = parseSemver(version)
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`
  throw new Error(`--bump 只支持 major/minor/patch: ${bump}`)
}

export function readLatestYmlVersion(content) {
  const match = /^version:\s*(.+)$/m.exec(content)
  return match?.[1]?.trim() ?? ''
}

function latestYmlVersion() {
  const path = join(releaseDir, 'latest.yml')
  if (!existsSync(path)) return ''
  return readLatestYmlVersion(readFileSync(path, 'utf8'))
}

function releaseNotesTopVersion() {
  if (!existsSync(releaseNotesJson)) return ''
  const notes = readJson(releaseNotesJson)
  return notes[0]?.version ?? ''
}

function currentEditorVersion() {
  return readJson(editorPackageJson).version
}

function determineTargetVersion(args, currentVersion) {
  if (args.version && args.bump) throw new Error('不能同时传 --version 和 --bump')
  if (args.version) {
    parseSemver(args.version)
    if (compareVersions(args.version, currentVersion) < 0) {
      throw new Error(`目标版本 ${args.version} 不能低于当前版本 ${currentVersion}`)
    }
    return args.version
  }
  if (args.bump) return bumpVersion(currentVersion, args.bump)
  if (args.uploadOnly || args.resume) return currentVersion
  throw new Error('请传 --version X.Y.Z 或 --bump patch|minor|major')
}

function assertCleanWorktree(dryRun) {
  const status = git(['status', '--porcelain'])
  if (!status) return
  if (dryRun) {
    log(`预检: 工作区不干净；dry-run 继续，仅打印流程。\n${status}`)
    return
  }
  die(`工作区不干净，请先提交或暂存无关改动。\n${status}`)
}

function assertMainBranch(allowNonMain) {
  const branch = git(['branch', '--show-current'])
  if (branch !== 'main' && !allowNonMain) {
    die(`当前分支是 ${branch || '(detached)'}，发布默认只允许在 main 上执行`)
  }
}

function gitExitCode(args) {
  return spawnSync('git', args, { cwd: repoRoot, stdio: 'ignore' }).status ?? 1
}

function assertUpToDateWithUpstream(allowLocalAhead) {
  const upstream = gitMaybe(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  if (!upstream) die('当前分支没有 upstream，无法确认是否与远端同步')
  const local = git(['rev-parse', 'HEAD'])
  const remote = git(['rev-parse', '@{u}'])
  if (local === remote) return
  if (allowLocalAhead && gitExitCode(['merge-base', '--is-ancestor', remote, local]) === 0) {
    log(`同步: 本地已领先 ${upstream}，按 resume 流程继续`)
    return
  }
  die(`当前分支与 ${upstream} 不同步，请先 pull/rebase 或 push 后再发布`)
}

function tagExists(tag) {
  return Boolean(gitMaybe(['rev-parse', '-q', '--verify', `refs/tags/${tag}`]))
}

function tagCommit(tag) {
  return gitMaybe(['rev-list', '-n', '1', tag])
}

function sortedVersionTags() {
  const out = gitMaybe(['tag', '--list', 'v*', '--sort=v:refname'])
  return out ? out.split('\n').filter(Boolean) : []
}

function previousTagFor(targetTag) {
  const tags = sortedVersionTags().filter((tag) => tag !== targetTag)
  return tags.at(-1) ?? ''
}

function uploadArgs(args) {
  const out = []
  for (const [flag, key] of [
    ['--host', 'host'],
    ['--user', 'user'],
    ['--dir', 'dir'],
    ['--port', 'port'],
    ['--key', 'key'],
    ['--remote-os', 'remoteOs'],
  ]) {
    if (args[key]) out.push(flag, args[key])
  }
  return out
}

function assertUploadConfig(args) {
  const host = args.host ?? process.env.UE_RELEASE_HOST
  const user = args.user ?? process.env.UE_RELEASE_USER
  const dir = args.dir ?? process.env.UE_RELEASE_DIR
  if (!host || !user || !dir) {
    die('上传需要 --host/--user/--dir，或设置 UE_RELEASE_HOST/UE_RELEASE_USER/UE_RELEASE_DIR')
  }
}

function updateEditorVersion(version, dryRun) {
  const pkg = readJson(editorPackageJson)
  if (pkg.version === version) {
    log(`版本: apps/editor/package.json 已是 ${version}`)
    return
  }
  pkg.version = version
  writeJson(editorPackageJson, pkg, dryRun)
  log(`版本: apps/editor/package.json ${version}`)
}

function generateReleaseNotes(version, dryRun) {
  run(process.execPath, ['scripts/release/changelog.mjs', '--pending-version', version], { dryRun })
  if (dryRun) return
  const top = releaseNotesTopVersion()
  if (top !== version) die(`release-notes.json 顶部版本是 ${top || '(空)'}，期望 ${version}`)
}

function changedReleaseFiles() {
  return git([
    'status',
    '--porcelain',
    '--',
    'apps/editor/package.json',
    'apps/editor/resources/release-notes.json',
  ])
}

function commitReleaseFiles(version, dryRun) {
  const status = changedReleaseFiles()
  if (!status) {
    log('提交: 版本文件和 release notes 无变化，跳过 commit')
    return
  }
  run('git', ['add', 'apps/editor/package.json', 'apps/editor/resources/release-notes.json'], {
    dryRun,
  })
  run('git', ['commit', '-m', `chore(release): ${version}`], { dryRun })
}

function removeOldReleaseDir(dryRun) {
  if (dryRun) {
    log(`  [dry-run] remove ${releaseDir}`)
    return
  }
  rmSync(releaseDir, { recursive: true, force: true })
}

function listArtifacts() {
  if (!existsSync(releaseDir)) return []
  return readdirSync(releaseDir)
    .filter((file) => file === 'latest.yml' || file.endsWith('.exe') || file.endsWith('.blockmap'))
    .sort((a, b) => {
      if (a === 'latest.yml') return 1
      if (b === 'latest.yml') return -1
      return a.localeCompare(b)
    })
}

function hashFile(path) {
  return createHash('sha512').update(readFileSync(path)).digest('hex')
}

function artifactInfo() {
  return listArtifacts().map((file) => {
    const path = join(releaseDir, file)
    return {
      file,
      size: statSync(path).size,
      sha512: hashFile(path),
    }
  })
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  const mib = bytes / 1024 / 1024
  return `${mib.toFixed(1)} MiB`
}

function commitSubjects(range) {
  const out = gitMaybe(['log', range, '--no-merges', '--pretty=format:%h %s'])
  return out ? out.split('\n') : []
}

export function buildReport({
  version,
  previousTag,
  commitRange,
  commits,
  artifacts,
  uploadTarget,
}) {
  const lines = [
    `# Universe Editor ${version}`,
    '',
    `- Previous tag: ${previousTag || '(none)'}`,
    `- Commit range: ${commitRange}`,
    `- Upload target: ${uploadTarget || '(not uploaded)'}`,
    '',
    '## Commits',
    '',
  ]
  if (commits.length === 0) lines.push('- (none)')
  else lines.push(...commits.map((commit) => `- ${commit}`))
  lines.push('', '## Artifacts', '')
  if (artifacts.length === 0) {
    lines.push('- (none)')
  } else {
    for (const artifact of artifacts) {
      lines.push(`- ${artifact.file} (${formatBytes(artifact.size)})`)
      lines.push(`  sha512: ${artifact.sha512}`)
    }
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

function uploadTarget(args) {
  const host = args.host ?? process.env.UE_RELEASE_HOST
  const user = args.user ?? process.env.UE_RELEASE_USER
  const dir = args.dir ?? process.env.UE_RELEASE_DIR
  if (!host || !user || !dir) return ''
  return `${user}@${host}:${dir}`
}

function writeReport(version, previousTag, args, dryRun) {
  const commitRange = previousTag ? `${previousTag}..HEAD` : 'HEAD'
  const report = buildReport({
    version,
    previousTag,
    commitRange,
    commits: commitSubjects(commitRange),
    artifacts: artifactInfo(),
    uploadTarget: args.noUpload ? '' : uploadTarget(args),
  })
  const reportPath = join(releaseDir, `release-report-v${version}.md`)
  if (dryRun) {
    log(`  [dry-run] write ${reportPath}`)
    return
  }
  mkdirSync(releaseDir, { recursive: true })
  writeFileSync(reportPath, report, 'utf8')
  log(`报告: ${reportPath}`)
}

function verifyPackagedVersion(version) {
  const packagedVersion = latestYmlVersion()
  if (packagedVersion !== version) {
    die(`latest.yml 版本是 ${packagedVersion || '(空)'}，期望 ${version}`)
  }
  const artifacts = listArtifacts()
  if (!artifacts.some((file) => file.endsWith('.exe'))) die('release/ 下没有 .exe 产物')
  if (!artifacts.some((file) => file.endsWith('.blockmap'))) die('release/ 下没有 .blockmap 产物')
  if (!artifacts.includes('latest.yml')) die('release/ 下没有 latest.yml')
}

function createTagIfNeeded(tag, dryRun, resume) {
  if (tagExists(tag)) {
    if (!resume) die(`${tag} 已存在；如需继续上传已有版本，请使用 --resume 或 --upload-only`)
    log(`Tag: ${tag} 已存在，跳过创建`)
    return
  }
  run('git', ['tag', '-a', tag, '-m', `Universe Editor ${tag.slice(1)}`], { dryRun })
}

function pushRelease(tag, dryRun) {
  run('git', ['push', 'origin', 'HEAD:main'], { dryRun })
  run('git', ['push', 'origin', tag], { dryRun })
}

function packageRelease(args, dryRun) {
  const script = args.packageScript ?? 'package:win:installer'
  removeOldReleaseDir(dryRun)
  run('pnpm', ['--filter', '@universe-editor/editor', script], { dryRun })
}

function runChecks(args, dryRun) {
  if (args.skipCheck) {
    log('校验: 跳过 pnpm check / test:release')
    return
  }
  run('pnpm', ['check'], { dryRun })
  run('pnpm', ['test:release'], { dryRun })
  if (args.e2e && !args.skipE2e) run('pnpm', ['e2e'], { dryRun })
}

function assertTagAtHead(tag) {
  if (!tagExists(tag)) return
  const head = git(['rev-parse', 'HEAD'])
  const tagged = tagCommit(tag)
  if (tagged !== head) {
    die(`${tag} 指向 ${tagged}，但当前 HEAD 是 ${head}；请 checkout 到该 tag 对应提交后重试`)
  }
}

function assertCurrentVersionHasTagBeforeNextRelease(currentVersion, targetVersion) {
  if (targetVersion === currentVersion) return
  if (sortedVersionTags().length === 0) return
  const currentTag = `v${currentVersion}`
  if (!tagExists(currentTag)) {
    die(
      `当前 package 版本是 ${currentVersion}，但缺少 ${currentTag}。` +
        `请先发布/补 tag 当前版本，再发布 ${targetVersion}`,
    )
  }
}

function preflight(args, currentVersion, targetVersion, targetTag) {
  assertCleanWorktree(args.dryRun)
  assertMainBranch(args.allowNonMain)
  if (!args.noPush && !args.dryRun) run('git', ['fetch', '--tags', 'origin'], { dryRun: false })
  if (!args.noPush && !args.uploadOnly) assertUpToDateWithUpstream(args.resume)
  if (!args.noUpload) assertUploadConfig(args)
  assertCurrentVersionHasTagBeforeNextRelease(currentVersion, targetVersion)
  if (tagExists(targetTag) && !args.resume && !args.uploadOnly) {
    die(`${targetTag} 已存在；如需继续已有版本，请使用 --resume 或 --upload-only`)
  }
  if ((args.resume || args.uploadOnly) && tagExists(targetTag)) {
    assertTagAtHead(targetTag)
  }
  if (!args.uploadOnly && compareVersions(targetVersion, currentVersion) < 0) {
    die(`目标版本 ${targetVersion} 低于当前版本 ${currentVersion}`)
  }
}

function runRelease(args) {
  const currentVersion = currentEditorVersion()
  let targetVersion
  try {
    targetVersion = determineTargetVersion(args, currentVersion)
  } catch (error) {
    die(error.message)
  }
  const targetTag = `v${targetVersion}`
  const dryRun = Boolean(args.dryRun)

  log(`\nUniverse Editor release ${targetVersion}`)
  log(
    `Mode: ${args.uploadOnly ? 'upload-only' : args.resume ? 'resume' : 'full'}${dryRun ? ' (dry-run)' : ''}`,
  )
  log('')

  preflight(args, currentVersion, targetVersion, targetTag)
  const previousTag = previousTagFor(targetTag)
  log(`Previous tag: ${previousTag || '(none)'}`)
  log('')

  if (!args.uploadOnly) {
    updateEditorVersion(targetVersion, dryRun)
    generateReleaseNotes(targetVersion, dryRun)
    commitReleaseFiles(targetVersion, dryRun)
    runChecks(args, dryRun)
  }

  packageRelease(args, dryRun)
  if (!dryRun) verifyPackagedVersion(targetVersion)
  writeReport(targetVersion, previousTag, args, dryRun)

  if (!args.uploadOnly) createTagIfNeeded(targetTag, dryRun, args.resume)
  if (!args.noPush && !args.uploadOnly) pushRelease(targetTag, dryRun)
  if (!args.noUpload)
    run(process.execPath, ['scripts/release/upload.mjs', ...uploadArgs(args)], { dryRun })

  log(`\n完成: Universe Editor ${targetVersion}`)
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    die(error.message)
  }
  runRelease(args)
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
