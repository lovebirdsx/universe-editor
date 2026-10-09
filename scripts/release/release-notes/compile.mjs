#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Release-notes compiler: docs/release-notes sources (one file per new version, plus the
 *  frozen `archive/*.md` aggregates of historical notes) → runtime JSON + static site
 *  bundle + GitHub Release body, plus the manifest that ties them together.
 *
 *    pnpm release:notes -- --version 0.15.0   compile up to that version, write the
 *                                             runtime JSON (canonical, Git-tracked) + snapshot
 *    pnpm release:notes:check                 no-write validation + canonical drift check
 *    node compile.mjs --bundle <dir>          materialize the upload bundle from the snapshot
 *    node compile.mjs --github-body 0.15.0 --github-out <file>
 *    node compile.mjs --expect-version 0.15.0 packaged-app gate (see package-editor.mjs)
 *
 *  Deterministic by construction: no wall-clock, no network, no `git remote` — the same
 *  sources always produce byte-identical artifacts (that is what --check and --resume
 *  rely on). Old tags without docs/release-notes degrade to "legacy mode": nothing is
 *  gate-checked and nothing is regenerated.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseNoteBody, prepareTokens, renderHtml, renderMarkdown } from './markdown.mjs'
import { renderIndexPage, renderNotePage } from './page.mjs'
import {
  BUILD_SNAPSHOT_DIR,
  EDITOR_PACKAGE_JSON,
  LINK_POLICY,
  NOTES_SOURCE_DIR,
  REPO_ROOT,
  RUNTIME_JSON_PATH,
  assertReleaseNotesReady,
  buildSiteIndex,
  compareVersions,
  docSourcePath,
  indexNotesByVersion,
  isNoteFileName,
  parseNote,
  selectReleasableNotes,
  serializeRuntimeJson,
  splitAggregate,
} from './source.mjs'

const GENERATOR = 'scripts/release/release-notes/compile.mjs'

/** Product sentence kept at the bottom of the GitHub Release body. */
const GITHUB_APPENDIX =
  '双平台编辑器产物，供 samples 仓库 e2e 下载。可执行文件：linux-unpacked/universe-editor、' +
  'win-unpacked/Universe Editor.exe'

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

export function notesSourceAvailable(dir = NOTES_SOURCE_DIR) {
  return existsSync(dir)
}

function appVersion(packageJsonPath = EDITOR_PACKAGE_JSON) {
  return JSON.parse(readFileSync(packageJsonPath, 'utf8')).version
}

export function collectNoteFiles(dir = NOTES_SOURCE_DIR) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(isNoteFileName)
    // Byte order, not localeCompare: this order reaches manifest.json, whose bytes must not
    // depend on the host's locale/ICU (same reasoning as classifyReleaseDir in upload.mjs).
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => ({ name, path: join(dir, name) }))
}

/** Aggregate archives: each `archive/*.md` holds many frozen legacy notes as sections. */
export function collectArchiveFiles(dir = NOTES_SOURCE_DIR) {
  const archiveDir = join(dir, 'archive')
  if (!existsSync(archiveDir)) return []
  return readdirSync(archiveDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isNoteFileName(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    // `rel` is a POSIX-style relative path by construction — path.join would emit
    // backslashes on Windows and manifest.json bytes must not depend on the host.
    .map((name) => ({ rel: `archive/${name}`, path: join(archiveDir, name) }))
}

/** Every physical source file — root notes and archives alike — ordered by `rel`. */
export function collectSourceFiles(dir = NOTES_SOURCE_DIR) {
  const sources = [
    ...collectNoteFiles(dir).map((file) => ({ rel: file.name, path: file.path, kind: 'note' })),
    ...collectArchiveFiles(dir).map((file) => ({ ...file, kind: 'archive' })),
  ]
  return sources.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

const errorMessage = (error) => (error instanceof Error ? error.message : String(error))

/**
 * Parse every version note — plain `<version>.md` files and the sections of each
 * `archive/*.md` aggregate. Errors are aggregated so one run reports all of them —
 * a broken note deep in the history should not hide the one being written today.
 */
export function loadNotes(dir = NOTES_SOURCE_DIR) {
  const notes = []
  const errors = []
  for (const file of collectSourceFiles(dir)) {
    if (file.kind === 'note') {
      try {
        notes.push(parseNote(readFileSync(file.path, 'utf8'), { file: file.rel }))
      } catch (error) {
        errors.push(errorMessage(error))
      }
      continue
    }
    let sections
    try {
      sections = splitAggregate(readFileSync(file.path, 'utf8'), { label: file.rel })
    } catch (error) {
      errors.push(errorMessage(error))
      continue
    }
    for (const section of sections) {
      let note
      try {
        note = parseNote(section.text, {
          file: file.rel,
          expectedVersion: section.version,
          lineOffset: section.lineOffset,
        })
      } catch (error) {
        errors.push(errorMessage(error))
        continue
      }
      if (!note.legacy) {
        errors.push(
          `${file.rel}（${section.version} 分节）: 归档只收迁移稿（必须 legacy: true）；` +
            '新稿请写 docs/release-notes/<version>.md',
        )
        continue
      }
      notes.push(note)
    }
  }
  if (errors.length > 0) {
    throw new Error(`release notes 校验失败：\n  - ${errors.join('\n  - ')}`)
  }
  indexNotesByVersion(notes)
  return notes
}

function makeDocExists(repoRoot) {
  return (docId) => existsSync(join(repoRoot, docSourcePath(docId)))
}

/**
 * Validate every note (drafts included — a draft with broken syntax must fail early),
 * then render the ones a release may ship. `maxVersion` is the upper bound: future
 * versions and drafts never leak into an older release.
 */
export function compileNotes({ notes, maxVersion, repoRoot = REPO_ROOT }) {
  const docExists = makeDocExists(repoRoot)
  const warnings = []
  const parsed = new Map()
  for (const note of notes) {
    const label = `docs/release-notes/${note.label}`
    // Missing docs are fatal for the version being released and a warning for the rest
    // (the app falls back to the version-pinned public link for historical notes).
    const isTarget = note.version === maxVersion
    const { tokens, warnings: linkWarnings } = parseNoteBody(note.body, {
      label,
      lineOffset: note.bodyLine - 1,
      ...(isTarget ? {} : { docExists }),
    })
    warnings.push(...linkWarnings)
    parsed.set(note.version, tokens)
  }

  const selected = selectReleasableNotes(notes, maxVersion)
  for (const note of selected) {
    if (note.version !== maxVersion) continue
    for (const { href, line } of collectDocLinks(parsed.get(note.version), note.bodyLine - 1)) {
      if (!docExists(href)) {
        throw new Error(
          `docs/release-notes/${note.label}:${line}: 目标版本文档 ${docSourcePath(href)} 不存在`,
        )
      }
    }
  }

  const runtimeJson = serializeRuntimeJson(selected)
  const siteFiles = new Map()
  for (const note of selected) {
    const tokens = prepareTokens(parsed.get(note.version), { version: note.version })
    siteFiles.set(
      `notes/v${note.version}.html`,
      renderNotePage({ note, bodyHtml: renderHtml(tokens) }),
    )
  }
  siteFiles.set('notes/index.html', renderIndexPage({ notes: selected }))
  const index = `${JSON.stringify(buildSiteIndex(selected), null, 2)}\n`
  siteFiles.set('notes/index.json', index)

  return { selected, runtimeJson, siteFiles, warnings }
}

function collectDocLinks(tokens, lineOffset = 0) {
  const links = []
  for (const token of tokens) {
    if (token.type !== 'inline') continue
    for (const child of token.children ?? []) {
      if (child.type !== 'link_open') continue
      const href = child.attrGet('href') ?? ''
      if (href.startsWith(`${LINK_POLICY.docScheme}:`)) {
        links.push({
          href: href.slice(LINK_POLICY.docScheme.length + 1),
          line: (token.map?.[0] ?? 0) + 1 + lineOffset,
        })
      }
    }
  }
  return links
}

export function buildGithubBody({ notes, version }) {
  const note = indexNotesByVersion(notes).get(version)
  if (!note)
    throw new Error(`docs/release-notes/${version}.md 不存在，无法生成 GitHub Release 正文`)
  const { tokens } = parseNoteBody(note.body, {
    label: `docs/release-notes/${note.label}`,
    lineOffset: note.bodyLine - 1,
  })
  const body = renderMarkdown(prepareTokens(tokens, { version }))
  const heading = note.date ? `v${version} · ${note.date}` : `v${version}`
  const lines = [`# Universe Editor ${heading}`, '']
  if (note.title) lines.push(`**${note.title}**`, '')
  if (note.summary) lines.push(note.summary, '')
  lines.push('---', '', body.trimEnd(), '', '---', '', GITHUB_APPENDIX, '')
  return lines.join('\n')
}

function buildManifest({ notes, artifacts, version, notesDir = NOTES_SOURCE_DIR }) {
  const versionsByFile = new Map()
  for (const note of notes) {
    const versions = versionsByFile.get(note.file) ?? []
    versions.push(note.version)
    versionsByFile.set(note.file, versions)
  }
  const sourceFiles = collectSourceFiles(notesDir).map((file) => {
    const content = readFileSync(file.path, 'utf8').replace(/\r\n/g, '\n')
    const versions = versionsByFile.get(file.rel) ?? []
    return {
      file: file.rel,
      kind: file.kind,
      bytes: Buffer.byteLength(content, 'utf8'),
      sha256: sha256(content),
      versions: [...versions].sort((a, b) => compareVersions(b, a)),
    }
  })
  return {
    schema: 2,
    generator: GENERATOR,
    version,
    repo: LINK_POLICY.publicRepoBase,
    source: { dir: 'docs/release-notes', files: sourceFiles },
    artifacts,
  }
}

function artifactEntry(path, kind, upload, mode, content) {
  return {
    path,
    kind,
    upload,
    mode,
    bytes: Buffer.byteLength(content, 'utf8'),
    sha256: sha256(content),
  }
}

/**
 * Build every artifact of one compile so the runtime JSON shipped inside the installer
 * and the bundle uploaded next to it are provably the same bytes.
 */
export function compileAll({ maxVersion, notesDir = NOTES_SOURCE_DIR, repoRoot = REPO_ROOT } = {}) {
  const notes = loadNotes(notesDir)
  const bound = maxVersion ?? appVersion()
  const { selected, runtimeJson, siteFiles, warnings } = compileNotes({
    notes,
    maxVersion: bound,
    repoRoot,
  })
  const githubBody = selected.some((note) => note.version === bound)
    ? buildGithubBody({ notes, version: bound })
    : undefined

  const files = new Map()
  files.set('release-notes.json', runtimeJson)
  for (const [path, content] of siteFiles) files.set(path, content)
  if (githubBody !== undefined) files.set(`github-release-${bound}.md`, githubBody)

  const artifacts = [
    artifactEntry('release-notes.json', 'runtime', true, 'atomic', runtimeJson),
    artifactEntry('notes/index.json', 'index', true, 'atomic', siteFiles.get('notes/index.json')),
    artifactEntry('notes/index.html', 'index', true, 'atomic', siteFiles.get('notes/index.html')),
  ]
  for (const note of selected) {
    const path = `notes/v${note.version}.html`
    artifacts.push(artifactEntry(path, 'page', true, 'direct', siteFiles.get(path)))
  }
  if (githubBody !== undefined) {
    artifacts.push(
      artifactEntry(`github-release-${bound}.md`, 'github', false, 'direct', githubBody),
    )
  }

  const manifest = buildManifest({ notes, artifacts, version: bound, notesDir })
  files.set('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)
  return { notes, selected, files, runtimeJson, manifest, warnings, version: bound }
}

function writeFileAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, path)
}

function writeAll(root, files) {
  for (const [path, content] of files) writeFileAtomic(join(root, ...path.split('/')), content)
}

export function writeSnapshot({ snapshotDir = BUILD_SNAPSHOT_DIR, compiled }) {
  rmSync(snapshotDir, { recursive: true, force: true })
  mkdirSync(snapshotDir, { recursive: true })
  writeAll(snapshotDir, compiled.files)
  return snapshotDir
}

/** Materialize the upload bundle from the snapshot — never re-reading the sources. */
export function materializeBundle({
  bundleDir,
  snapshotDir = BUILD_SNAPSHOT_DIR,
  notesDir = NOTES_SOURCE_DIR,
}) {
  const manifest = readSnapshotManifest(snapshotDir)
  verifySnapshot(snapshotDir, manifest)
  const currentFiles = collectSourceFiles(notesDir)
  const byRel = new Map(currentFiles.map((file) => [file.rel, file]))
  const drifted = manifest.source.files
    .filter((entry) => {
      const file = byRel.get(entry.file)
      if (!file) return true
      return sha256(readFileSync(file.path, 'utf8').replace(/\r\n/g, '\n')) !== entry.sha256
    })
    .map((entry) => entry.file)
  const added = currentFiles.filter(
    (file) => !manifest.source.files.some((entry) => entry.file === file.rel),
  )
  if (drifted.length > 0 || added.length > 0) {
    throw new Error(
      `release notes 源文件在打包后发生变化（${drifted.join(', ') || '文件数量变化'}）；` +
        '请重新打包，不要用变化的源生成上传包',
    )
  }
  rmSync(bundleDir, { recursive: true, force: true })
  mkdirSync(bundleDir, { recursive: true })
  for (const artifact of manifest.artifacts) {
    const content = readFileSync(join(snapshotDir, ...artifact.path.split('/')))
    writeFileAtomic(join(bundleDir, ...artifact.path.split('/')), content)
  }
  writeFileAtomic(
    join(bundleDir, 'manifest.json'),
    readFileSync(join(snapshotDir, 'manifest.json'), 'utf8'),
  )
  return manifest
}

export function readSnapshotManifest(snapshotDir = BUILD_SNAPSHOT_DIR) {
  const path = join(snapshotDir, 'manifest.json')
  if (!existsSync(path)) {
    throw new Error(`缺少编译快照 ${path}；先运行 pnpm release:notes（或打包链的 compile 步骤）`)
  }
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function verifySnapshot(snapshotDir, manifest = readSnapshotManifest(snapshotDir)) {
  for (const artifact of manifest.artifacts) {
    const path = join(snapshotDir, ...artifact.path.split('/'))
    if (!existsSync(path)) throw new Error(`快照缺少产物 ${artifact.path}（${path}）`)
    const content = readFileSync(path)
    const digest = createHash('sha256').update(content).digest('hex')
    if (digest !== artifact.sha256) {
      throw new Error(
        `快照产物 ${artifact.path} 与 manifest 哈希不符（${digest} ≠ ${artifact.sha256}）`,
      )
    }
    if (content.length !== artifact.bytes) {
      throw new Error(`快照产物 ${artifact.path} 字节数与 manifest 不符`)
    }
  }
  return manifest
}

/** Compare the compiled runtime JSON with the Git-tracked canonical file. */
export function checkCanonical({ compiled, canonicalPath = RUNTIME_JSON_PATH }) {
  const rel = relative(REPO_ROOT, canonicalPath).split(sep).join('/')
  if (!existsSync(canonicalPath)) {
    throw new Error(`缺少 ${rel}；先运行 pnpm release:notes`)
  }
  const actual = readFileSync(canonicalPath, 'utf8')
  if (actual === compiled.runtimeJson) return
  throw new Error(
    `release notes 派生物漂移：${rel} 与重新编译结果不一致\n` +
      `  canonical sha256: ${sha256(actual)}\n  recompiled sha256: ${sha256(compiled.runtimeJson)}\n` +
      '  修正：pnpm release:notes -- --version <目标版本>（不要手改该 JSON）',
  )
}

export function assertExpectedVersion(version, packageJsonPath = EDITOR_PACKAGE_JSON) {
  const current = appVersion(packageJsonPath)
  if (current !== version) {
    throw new Error(`apps/editor/package.json 版本是 ${current}，期望 ${version}`)
  }
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    // `pnpm release:notes -- --version X` forwards the separator verbatim (pnpm 11).
    if (arg === '--') continue
    if (arg === '--check') out.check = true
    else if (arg === '--quiet') out.quiet = true
    else if (arg === '--version') out.version = requireValue(argv, ++i, arg)
    else if (arg === '--expect-version') out.expectVersion = requireValue(argv, ++i, arg)
    else if (arg === '--out') out.out = requireValue(argv, ++i, arg)
    else if (arg === '--bundle') out.bundle = requireValue(argv, ++i, arg)
    else if (arg === '--github-body') out.githubBody = requireValue(argv, ++i, arg)
    else if (arg === '--github-out') out.githubOut = requireValue(argv, ++i, arg)
    else throw new Error(`无法识别参数：${arg}`)
  }
  return out
}

function requireValue(argv, index, flag) {
  const value = argv[index]
  if (!value || value.startsWith('--')) throw new Error(`缺少 ${flag} 的值`)
  return value
}

function log(message) {
  console.log(message)
}

/**
 * What a tree is allowed to do when docs/release-notes does not exist (a historical tag, a
 * sparse checkout). Every entry point degrades — including `--bundle`, which otherwise blows
 * up at the very end of a packaging run that already staged and built everything. The GitHub
 * body is the one target with no fallback: it must never be rebuilt from the commit list.
 */
export function legacyOutcome(args, hasSources = notesSourceAvailable()) {
  if (hasSources) return 'compile'
  if (args.githubBody) return 'github-body-error'
  return 'skip'
}

function main(argv) {
  const args = parseArgs(argv)

  const outcome = legacyOutcome(args)
  if (outcome === 'github-body-error') {
    throw new Error(
      '该 tag 没有 docs/release-notes 源文件，无法生成新版正文（不支持从提交列表回退）',
    )
  }
  if (outcome === 'skip') {
    log('release notes: docs/release-notes 不存在，按 legacy 模式跳过（历史 tag 回填）')
    if (args.bundle) log('  （--bundle 一并跳过：无源可编译，不产出上传包）')
    return
  }

  if (args.bundle) {
    const manifest = materializeBundle({ bundleDir: resolve(REPO_ROOT, args.bundle) })
    log(
      `release notes 发布包已生成：${args.bundle}（版本 ${manifest.version}，` +
        `${manifest.artifacts.filter((a) => a.upload).length} 个上传文件）`,
    )
    return
  }

  if (args.expectVersion) assertExpectedVersion(args.expectVersion)

  if (args.githubBody) {
    const notes = loadNotes()
    const body = buildGithubBody({ notes, version: args.githubBody })
    if (args.githubOut) {
      writeFileAtomic(resolve(REPO_ROOT, args.githubOut), body)
      log(`GitHub Release 正文已生成：${args.githubOut}`)
    } else {
      process.stdout.write(body)
    }
    return
  }

  const compiled = compileAll({ maxVersion: args.version ?? args.expectVersion })
  for (const warning of compiled.warnings) console.warn(`⚠ ${warning}`)

  if (args.check) {
    checkCanonical({ compiled })
    log(
      `release notes 校验通过：${compiled.selected.length} 个版本（截至 ${compiled.version}），` +
        `${compiled.notes.length} 个版本稿 / ${compiled.manifest.source.files.length} 个源文件`,
    )
    return
  }

  if (args.version) {
    assertReleaseNotesReady({ notes: compiled.notes, version: args.version })
  }

  if (args.out) {
    const outDir = resolve(REPO_ROOT, args.out)
    writeAll(outDir, compiled.files)
    log(
      `release notes 已输出到 ${args.out}（${compiled.files.size} 个文件，版本 ${compiled.version}）`,
    )
    return
  }

  writeFileAtomic(RUNTIME_JSON_PATH, compiled.runtimeJson)
  writeSnapshot({ compiled })
  const pages = [...compiled.files.keys()].filter((path) => path.startsWith('notes/v')).length
  log(
    `release notes: ${compiled.selected.length} 个版本（${pages} 个版本页）→ ` +
      `${relative(REPO_ROOT, RUNTIME_JSON_PATH).split(sep).join('/')} + .release-notes-build/`,
  )
}

const isMain =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (isMain) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`\x1b[31m✗ ${error instanceof Error ? error.message : String(error)}\x1b[0m`)
    process.exit(1)
  }
}
