#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Universe Editor release orchestrator.
 *
 *  This script keeps the mutable release steps in one place:
 *  notes gate -> version bump -> compile notes -> commit -> checks -> package -> tag ->
 *  push -> upload.
 *
 *  Release notes are NOT written here anymore: the formal text is docs/release-notes/<v>.md
 *  (AI-drafted, human-reviewed, committed before the release). A full release only compiles
 *  it; --resume / --upload-only merely re-verify that the compiled artifacts still match the
 *  committed sources (their tag already points at HEAD, so any drift is fatal).
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
import {
  verifyPackagedRuntimeResources,
  verifyReleaseNotesArtifacts,
} from './runtime-resources.mjs'
import {
  assertReleaseNotesReady,
  BUILD_SNAPSHOT_DIR,
  RUNTIME_JSON_PATH,
} from './release-notes/source.mjs'
import { loadNotes } from './release-notes/compile.mjs'
import { generateSdkVersions } from '../ext-packages/generate-sdk-versions.mjs'
import { loadEnv } from '../lib/env.mjs'

loadEnv()

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')
const editorPackageJson = join(repoRoot, 'apps/editor/package.json')
const extensionApiPackageJson = join(repoRoot, 'packages/extension-api/package.json')
const extensionApiIndexTs = join(repoRoot, 'packages/extension-api/src/index.ts')
const releaseNotesJson = RUNTIME_JSON_PATH
const releaseNotesSnapshotDir = BUILD_SNAPSHOT_DIR
/** Where package-editor lands the upload bundle (see defaultBundleDir there). */
const notesBundleDir = join(repoRoot, 'apps/editor/release/release-notes')
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
  'env',
])

function camelCaseFlag(flag) {
  return flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}

export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    // `pnpm release -- --bump patch` forwards the separator verbatim (pnpm 11); the
    // documented repo-wide form must keep working.
    if (raw === '--') continue
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
    ...(options?.env ? { env: options.env } : {}),
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
  } else {
    pkg.version = version
    writeJson(editorPackageJson, pkg, dryRun)
    log(`版本: apps/editor/package.json ${version}`)
  }
  syncVersionSpace(version, dryRun)
}

/**
 * 单一版本空间：extension-api 包版本 = App 版本（engines.universe 对标编辑器版本，
 * 对齐 VSCode 的 product version 即 API 版本）。bump 时同步：
 *   1. packages/extension-api/package.json 的 version
 *   2. packages/extension-api/src/index.ts 的 `export const version` 常量
 *   3. 生成的 SDK 版本常量（uex / create-extension）
 *   4. 内置插件 extensions/* 的 engines.universe（minor bump 时守卫脚本 --fix）
 */
function syncVersionSpace(version, dryRun) {
  const apiPkg = readJson(extensionApiPackageJson)
  if (apiPkg.version !== version) {
    apiPkg.version = version
    writeJson(extensionApiPackageJson, apiPkg, dryRun)
    log(`版本: packages/extension-api/package.json ${version}`)
  }
  const indexText = readFileSync(extensionApiIndexTs, 'utf8')
  const nextIndexText = indexText.replace(
    /^export const version = '[^']+'$/m,
    `export const version = '${version}'`,
  )
  if (!/^export const version = '/m.test(indexText)) {
    die('packages/extension-api/src/index.ts 缺少 `export const version` 常量')
  }
  if (nextIndexText !== indexText) {
    if (dryRun) log(`  [dry-run] write ${extensionApiIndexTs}`)
    else writeFileSync(extensionApiIndexTs, nextIndexText, 'utf8')
    log(`版本: extension-api index.ts version 常量 ${version}`)
  }
  if (dryRun) {
    log(
      '  [dry-run] 将重新生成 SDK 版本常量（uex sdkVersion.ts / create-extension sdkVersions.ts）',
    )
  } else {
    const { updated } = generateSdkVersions({ repoRoot })
    for (const rel of updated) log(`版本: 已重新生成 ${rel}`)
  }
  run(process.execPath, ['scripts/check-builtin-extensions-engines.mjs', '--fix'], { dryRun })
}

/**
 * Release-notes gate, run BEFORE anything is written: a missing / still-draft target note,
 * a filename that disagrees with its frontmatter, a duplicate version or a `sourceFrom`
 * that does not match the previous tag all stop the release here — not after the version
 * bump has already rewritten half the tree.
 */
export function assertReleaseNotesPreflight({ version, previousTag, notesDir }) {
  const notes = loadNotes(notesDir)
  return assertReleaseNotesReady({ notes, version, previousTag })
}

/**
 * Commits made after the note's `sourceTo` are not covered by the draft's review. Report
 * them (never block): the author decides whether the note needs another pass.
 */
function reportCommitsAfterSourceTo(note) {
  if (!note.sourceTo) return
  const out = gitMaybe(['log', `${note.sourceTo}..HEAD`, '--no-merges', '--pretty=format:%h %s'])
  if (!out) return
  log(`注意: ${note.file} 的 sourceTo ${note.sourceTo} 之后还有提交（未纳入本次复核，仅提醒）：`)
  for (const line of out.split('\n')) log(`  ${line}`)
}

/**
 * Compile (full) or verify (resume / upload-only) the release notes. A full run writes the
 * canonical JSON + the build snapshot; the other modes must produce byte-identical output,
 * otherwise the tag that is already at HEAD no longer describes what would ship.
 */
function compileReleaseNotes(version, args, dryRun) {
  const verifyOnly = Boolean(args.resume || args.uploadOnly)
  const cliArgs = [
    ...(verifyOnly ? ['--check'] : []),
    '--version',
    version,
    '--expect-version',
    version,
  ]
  run(process.execPath, [join(__dirname, 'release-notes', 'compile.mjs'), ...cliArgs], { dryRun })
  if (dryRun) return
  const top = releaseNotesTopVersion()
  if (top !== version) die(`release-notes.json 顶部版本是 ${top || '(空)'}，期望 ${version}`)
}

/** 随 release commit 一起提交的版本相关文件（单一版本空间的全部落点）。 */
const RELEASE_FILE_GLOBS = [
  'apps/editor/package.json',
  'apps/editor/resources/release-notes.json',
  'packages/extension-api/package.json',
  'packages/extension-api/src/index.ts',
  'packages/uex/src/lib/sdkVersion.ts',
  'packages/create-extension/src/sdkVersions.ts',
  'extensions/*/package.json',
]

function changedReleaseFiles() {
  return git(['status', '--porcelain', '--', ...RELEASE_FILE_GLOBS])
}

function commitReleaseFiles(version, dryRun) {
  const status = changedReleaseFiles()
  if (!status) {
    log('提交: 版本文件和 release notes 无变化，跳过 commit')
    return
  }
  run('git', ['add', ...RELEASE_FILE_GLOBS], { dryRun })
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
  notes,
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
  lines.push('', '## Release notes', '')
  if (!notes) {
    lines.push('- (not compiled)')
  } else {
    lines.push(`- source version: ${notes.version}`)
    for (const artifact of notes.artifacts) {
      const suffix = artifact.upload ? '' : ' (本地，不上传)'
      lines.push(`- ${artifact.path} (${artifact.bytes} B)${suffix}`)
      lines.push(`  sha256: ${artifact.sha256}`)
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

function writeReport(version, previousTag, args, dryRun, notes) {
  const commitRange = previousTag ? `${previousTag}..HEAD` : 'HEAD'
  const report = buildReport({
    version,
    previousTag,
    commitRange,
    commits: commitSubjects(commitRange),
    artifacts: artifactInfo(),
    uploadTarget: args.noUpload ? '' : uploadTarget(args),
    ...(notes ? { notes } : {}),
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

/**
 * The unpacked app dir depends on the packaging target; the notes check needs the one this
 * run produced (win by default, linux for `--package-script package:linux:dir`).
 */
export function packagedResourcesRoot({ winRoot, linuxRoot, exists = existsSync } = {}) {
  const candidates = [
    winRoot ?? join(releaseDir, 'win-unpacked/resources'),
    linuxRoot ?? join(releaseDir, 'linux-unpacked/resources'),
  ]
  return candidates.find((root) => exists(root)) ?? candidates[0]
}

function verifyReleaseNotesConsistency(version, packagedRoot) {
  if (!existsSync(notesBundleDir)) {
    die(`缺少 release notes 上传包 ${notesBundleDir}；打包链应已生成（package-editor 的最后一步）`)
  }
  const manifestPath = join(notesBundleDir, 'manifest.json')
  const manifest = readJson(manifestPath)
  if (manifest.version !== version) {
    die(`notes 上传包版本是 ${manifest.version || '(空)'}，期望 ${version}`)
  }
  try {
    // Also asserts packaged ≡ canonical and packaged ≡ the upload manifest's sha256.
    verifyReleaseNotesArtifacts({ resourcesRoot: packagedRoot, bundleDir: notesBundleDir })
  } catch (error) {
    die(error instanceof Error ? error.message : String(error))
  }
  if (!existsSync(releaseNotesSnapshotDir)) {
    die(`缺少 release notes 编译快照 ${releaseNotesSnapshotDir}；打包链应已重新生成`)
  }
  return manifest
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
  const packagedRoot = packagedResourcesRoot()
  try {
    verifyPackagedRuntimeResources(packagedRoot)
  } catch (error) {
    die(error instanceof Error ? error.message : String(error))
  }
  return verifyReleaseNotesConsistency(version, packagedRoot)
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

// .env.prod 里的 UE_SERVER_* 部署路径（如 /srv/auth/market-key.pem）不该泄漏进
// 测试子进程——server/gallery 测试 fixture 自带临时密钥，env 优先级高于 CLI 缺省，
// 不剥离会让 server.mjs 回落到部署机路径而启动失败（本地文件不存在）。
function testEnv() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('UE_SERVER_')) delete env[key]
  }
  return env
}

function runChecks(args, dryRun) {
  if (args.skipCheck) {
    log('校验: 跳过 pnpm check / test:release')
    return
  }
  const env = testEnv()
  run('pnpm', ['check'], { dryRun, env })
  run('pnpm', ['test:release'], { dryRun, env })
  if (args.e2e && !args.skipE2e) run('pnpm', ['e2e'], { dryRun, env })
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

/** Which of the three release modes this invocation is in. */
export function releaseMode(args) {
  if (args.uploadOnly) return 'upload-only'
  if (args.resume) return 'resume'
  return 'full'
}

/**
 * The release sequence, in order — `runRelease` walks exactly this list (read-only preflight
 * runs before the loop; nothing else is hard-coded there).
 *
 * Two invariants are encoded here rather than in prose: `notesGate` runs in every mode and
 * always before `versionBump` (a missing/draft note must not leave a half-bumped tree), and
 * only a full release mutates the tree (`versionBump` / `commit` / the notes write) while
 * `--resume` / `--upload-only` merely re-verify the already-tagged HEAD.
 */
export const RELEASE_STEPS = [
  { id: 'notesGate', modes: ['full', 'resume', 'upload-only'] },
  { id: 'versionBump', modes: ['full'] },
  { id: 'compileNotes', modes: ['full', 'resume', 'upload-only'] },
  { id: 'commit', modes: ['full'] },
  { id: 'checks', modes: ['full', 'resume'] },
  { id: 'package', modes: ['full', 'resume', 'upload-only'] },
  { id: 'verifyPackaged', modes: ['full', 'resume', 'upload-only'] },
  { id: 'report', modes: ['full', 'resume', 'upload-only'] },
  { id: 'tag', modes: ['full', 'resume'] },
  { id: 'push', modes: ['full', 'resume'] },
  { id: 'upload', modes: ['full', 'resume', 'upload-only'] },
]

/** One implementation per RELEASE_STEPS id; the table decides when each one runs. */
function releaseRunners({ state, args, dryRun }) {
  const { targetVersion, targetTag, previousTag } = state
  return {
    notesGate: () => {
      try {
        state.note = assertReleaseNotesPreflight({ version: targetVersion, previousTag })
      } catch (error) {
        die(error instanceof Error ? error.message : String(error))
      }
      if (!state.note.legacy) reportCommitsAfterSourceTo(state.note)
    },
    versionBump: () => updateEditorVersion(targetVersion, dryRun),
    compileNotes: () => compileReleaseNotes(targetVersion, args, dryRun),
    commit: () => commitReleaseFiles(targetVersion, dryRun),
    checks: () => runChecks(args, dryRun),
    package: () => packageRelease(args, dryRun),
    verifyPackaged: () => {
      if (!dryRun) state.notesManifest = verifyPackagedVersion(targetVersion)
    },
    report: () => writeReport(targetVersion, previousTag, args, dryRun, state.notesManifest),
    tag: () => createTagIfNeeded(targetTag, dryRun, args.resume),
    push: () => {
      if (!args.noPush) pushRelease(targetTag, dryRun)
    },
    upload: () => {
      if (!args.noUpload) {
        run(process.execPath, ['scripts/release/upload.mjs', ...uploadArgs(args)], { dryRun })
      }
    },
  }
}

/** True when `stepId` runs in `mode`. Unknown ids throw — a typo must not silently skip. */
export function stepRuns(stepId, mode) {
  const step = RELEASE_STEPS.find((candidate) => candidate.id === stepId)
  if (!step) throw new Error(`未知的发布步骤：${stepId}`)
  return step.modes.includes(mode)
}

/** Steps that only re-verify (never rewrite) in the given mode. */
export function compilesNotesForWrite(mode) {
  return mode === 'full'
}

/**
 * Read-only gate. It also refreshes tags, which is why it returns `previousTag`: callers
 * cannot resolve that value beforehand without risking a stale local tag list (a fresh
 * clone, or a tag a teammate just pushed, would otherwise fail the notes gate against the
 * wrong baseline). `--dry-run`/`--no-push` intentionally skip the fetch and stay offline.
 */
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
  return { previousTag: previousTagFor(targetTag) }
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
  const mode = releaseMode(args)

  log(`\nUniverse Editor release ${targetVersion}`)
  log(`Mode: ${mode}${dryRun ? ' (dry-run)' : ''}`)
  log('')

  // Read-only gate first (it also does `git fetch`): the notes step inside the loop then
  // guarantees a missing/draft note never leaves a half-bumped tree behind. `previousTag`
  // comes back from it so the tag list it was derived from is the freshly fetched one.
  const { previousTag } = preflight(args, currentVersion, targetVersion, targetTag)
  log(`Previous tag: ${previousTag || '(none)'}`)
  log('')

  // The table (RELEASE_STEPS), not this loop, decides the order: `compileNotes` must run
  // before `commit` so the regenerated release-notes.json lands in the release commit
  // (tagging a tree whose JSON lacks the new version would ship a stale intro page).
  const state = { targetVersion, targetTag, previousTag, note: undefined, notesManifest: undefined }
  const runners = releaseRunners({ state, args, dryRun })
  for (const step of RELEASE_STEPS) {
    if (!stepRuns(step.id, mode)) continue
    const runner = runners[step.id]
    if (!runner) die(`发布步骤 ${step.id} 没有实现`)
    runner()
  }

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
