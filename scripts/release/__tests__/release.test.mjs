/*---------------------------------------------------------------------------------------------
 *  Tests for release.mjs pure helpers. Run with `node --test`.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir } from '../../lib/temp-root.mjs'
import {
  assertReleaseNotesPreflight,
  buildReport,
  bumpVersion,
  commandName,
  compareVersions,
  compilesNotesForWrite,
  packagedResourcesRoot,
  parseArgs,
  readLatestYmlVersion,
  RELEASE_STEPS,
  releaseMode,
  shouldUseShell,
  stepRuns,
} from '../release.mjs'

test('parseArgs reads release mode and upload options', () => {
  assert.deepEqual(
    parseArgs([
      '--version',
      '0.2.0',
      '--dry-run',
      '--no-upload',
      '--host',
      '192.0.2.10',
      '--remote-os',
      'linux',
    ]),
    {
      version: '0.2.0',
      dryRun: true,
      noUpload: true,
      host: '192.0.2.10',
      remoteOs: 'linux',
    },
  )
})

test('parseArgs rejects unknown or missing values', () => {
  assert.throws(() => parseArgs(['--wat']), /无法识别参数/)
  assert.throws(() => parseArgs(['--version']), /缺少 --version 的值/)
  assert.throws(() => parseArgs(['oops']), /无法识别参数/)
})

test('parseArgs reads --env', () => {
  assert.deepEqual(parseArgs(['--env', 'prod']), { env: 'prod' })
  assert.throws(() => parseArgs(['--env']), /缺少 --env 的值/)
})

test('parseArgs tolerates the separator pnpm forwards verbatim', () => {
  // `pnpm release -- --bump patch` (the documented form) delivers a literal `--`.
  assert.deepEqual(parseArgs(['--', '--bump', 'patch']), { bump: 'patch' })
  assert.deepEqual(parseArgs(['--version', '0.2.0', '--']), { version: '0.2.0' })
})

test('bumpVersion supports stable semver bumps', () => {
  assert.equal(bumpVersion('0.1.4', 'patch'), '0.1.5')
  assert.equal(bumpVersion('0.1.4', 'minor'), '0.2.0')
  assert.equal(bumpVersion('0.1.4', 'major'), '1.0.0')
  assert.throws(() => bumpVersion('0.1', 'patch'), /版本号必须是 X.Y.Z/)
  assert.throws(() => bumpVersion('0.1.4', 'pre'), /只支持 major\/minor\/patch/)
})

test('compareVersions compares numeric segments', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1)
})

test('readLatestYmlVersion extracts manifest version', () => {
  assert.equal(readLatestYmlVersion('version: 0.1.5\npath: app.exe\n'), '0.1.5')
  assert.equal(readLatestYmlVersion('path: app.exe\n'), '')
})

test('pnpm runs through the shell on Windows', () => {
  assert.equal(commandName('git'), 'git')
  assert.equal(commandName('pnpm'), 'pnpm')
  assert.equal(shouldUseShell('git'), false)
  assert.equal(shouldUseShell('pnpm'), process.platform === 'win32')
})

test('buildReport includes commits and artifact hashes', () => {
  const report = buildReport({
    version: '0.1.5',
    previousTag: 'v0.1.4',
    commitRange: 'v0.1.4..HEAD',
    commits: ['abc123 feat: add thing'],
    artifacts: [{ file: 'latest.yml', size: 512, sha512: 'hash' }],
    uploadTarget: 'deploy@example:/srv/universe-editor',
  })

  assert.match(report, /# Universe Editor 0\.1\.5/)
  assert.match(report, /Previous tag: v0\.1\.4/)
  assert.match(report, /abc123 feat: add thing/)
  assert.match(report, /latest\.yml \(512 B\)/)
  assert.match(report, /sha512: hash/)
})

// ---------------------------------------------------------------- release notes gate

function noteText({
  version = '0.15.0',
  date = '2026-10-10',
  status = 'reviewed',
  legacy,
  sourceFrom = 'v0.14.9',
  sourceTo = 'a'.repeat(40),
} = {}) {
  const lines = [
    '---',
    `version: ${version}`,
    ...(date === null ? [] : [`date: ${date}`]),
    `title: 更快的启动`,
    `summary: 一句话摘要。`,
    `status: ${status}`,
    ...(legacy ? ['legacy: true'] : []),
    ...(sourceFrom === null ? [] : [`sourceFrom: ${sourceFrom}`]),
    ...(sourceTo === null ? [] : [`sourceTo: ${sourceTo}`]),
    '---',
    '',
    '## 本次重点',
    '',
    '- 一条',
    '',
  ]
  return lines.join('\n')
}

function notesDirWith(files) {
  const dir = mkTempDir('ue-release-notes-gate-')
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, 'utf8')
  return dir
}

test('assertReleaseNotesPreflight returns the ready note for the target version', () => {
  const dir = notesDirWith({
    '0.15.0.md': noteText(),
    '0.14.9.md': noteText({
      version: '0.14.9',
      date: null,
      legacy: true,
      sourceFrom: null,
      sourceTo: null,
      status: 'reviewed',
    }),
  })
  try {
    const note = assertReleaseNotesPreflight({
      version: '0.15.0',
      previousTag: 'v0.14.9',
      notesDir: dir,
    })
    assert.equal(note.version, '0.15.0')
    assert.equal(note.legacy, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('assertReleaseNotesPreflight blocks a missing, still-draft or misaligned note', () => {
  const missing = notesDirWith({
    '0.14.9.md': noteText({
      version: '0.14.9',
      date: null,
      legacy: true,
      sourceFrom: null,
      sourceTo: null,
    }),
  })
  try {
    assert.throws(
      () =>
        assertReleaseNotesPreflight({
          version: '0.15.0',
          previousTag: 'v0.14.9',
          notesDir: missing,
        }),
      /缺少 docs\/release-notes\/0\.15\.0\.md/,
    )
  } finally {
    rmSync(missing, { recursive: true, force: true })
  }

  const draft = notesDirWith({ '0.15.0.md': noteText({ status: 'draft' }) })
  try {
    assert.throws(
      () =>
        assertReleaseNotesPreflight({ version: '0.15.0', previousTag: 'v0.14.9', notesDir: draft }),
      /status: draft/,
    )
  } finally {
    rmSync(draft, { recursive: true, force: true })
  }

  const misaligned = notesDirWith({ '0.15.0.md': noteText({ sourceFrom: 'v0.14.7' }) })
  try {
    assert.throws(
      () =>
        assertReleaseNotesPreflight({
          version: '0.15.0',
          previousTag: 'v0.14.9',
          notesDir: misaligned,
        }),
      /期望 v0\.14\.9/,
    )
  } finally {
    rmSync(misaligned, { recursive: true, force: true })
  }
})

test('a legacy archive note satisfies the gate without a source range', () => {
  const dir = notesDirWith({
    '0.14.9.md': noteText({
      version: '0.14.9',
      date: null,
      legacy: true,
      sourceFrom: null,
      sourceTo: null,
    }),
  })
  try {
    const note = assertReleaseNotesPreflight({
      version: '0.14.9',
      previousTag: 'v0.14.8',
      notesDir: dir,
    })
    assert.equal(note.legacy, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('RELEASE_STEPS gates the notes before the version bump, and modes only re-verify', () => {
  const ids = RELEASE_STEPS.map((step) => step.id)
  assert.equal(ids[0], 'notesGate')
  assert.ok(ids.indexOf('notesGate') < ids.indexOf('versionBump'))
  assert.ok(ids.indexOf('versionBump') < ids.indexOf('compileNotes'))
  // The regenerated canonical JSON must be in the release commit, not dirty after it.
  assert.ok(ids.indexOf('compileNotes') < ids.indexOf('commit'))
  assert.ok(ids.indexOf('commit') < ids.indexOf('package'))
  // The audit report reads the packaged-notes manifest, so it comes after verification.
  assert.ok(ids.indexOf('verifyPackaged') < ids.indexOf('report'))
  assert.ok(ids.indexOf('report') < ids.indexOf('tag'))
  assert.equal(new Set(ids).size, ids.length)

  for (const mode of ['full', 'resume', 'upload-only']) {
    assert.equal(stepRuns('notesGate', mode), true, mode)
    assert.equal(stepRuns('package', mode), true, mode)
    assert.equal(stepRuns('verifyPackaged', mode), true, mode)
    assert.equal(stepRuns('report', mode), true, mode)
    assert.equal(stepRuns('upload', mode), true, mode)
  }
  for (const mode of ['resume', 'upload-only']) {
    // The tagged HEAD is already bumped and committed; re-running either would move it.
    assert.equal(stepRuns('versionBump', mode), false, mode)
    assert.equal(stepRuns('commit', mode), false, mode)
    assert.equal(compilesNotesForWrite(mode), false, mode)
  }
  assert.equal(stepRuns('versionBump', 'full'), true)
  assert.equal(stepRuns('commit', 'full'), true)
  assert.equal(compilesNotesForWrite('full'), true)
  // upload-only retries the upload of an existing tag: nothing local runs again.
  assert.equal(stepRuns('checks', 'upload-only'), false)
  assert.equal(stepRuns('tag', 'upload-only'), false)
  assert.equal(stepRuns('push', 'upload-only'), false)
  assert.equal(stepRuns('checks', 'resume'), true)
  assert.throws(() => stepRuns('nope', 'full'), /未知的发布步骤/)
  assert.equal(releaseMode({}), 'full')
  assert.equal(releaseMode({ resume: true }), 'resume')
  assert.equal(releaseMode({ uploadOnly: true }), 'upload-only')
})

test('packagedResourcesRoot follows the packaging target', () => {
  const win = 'release/win-unpacked/resources'
  const linux = 'release/linux-unpacked/resources'
  assert.equal(packagedResourcesRoot({ winRoot: win, linuxRoot: linux, exists: () => false }), win)
  assert.equal(
    packagedResourcesRoot({ winRoot: win, linuxRoot: linux, exists: (p) => p === linux }),
    linux,
  )
  assert.equal(
    packagedResourcesRoot({ winRoot: win, linuxRoot: linux, exists: (p) => p === win }),
    win,
  )
})

test('buildReport adds the compiled notes section', () => {
  const report = buildReport({
    version: '0.15.0',
    previousTag: 'v0.14.9',
    commitRange: 'v0.14.9..HEAD',
    commits: [],
    artifacts: [],
    uploadTarget: '',
    notes: {
      version: '0.15.0',
      artifacts: [
        { path: 'release-notes.json', bytes: 10, sha256: 'a'.repeat(64), upload: true },
        { path: 'github-release-0.15.0.md', bytes: 4, sha256: 'b'.repeat(64), upload: false },
      ],
    },
  })
  assert.match(report, /## Release notes/)
  assert.match(report, /source version: 0\.15\.0/)
  assert.match(report, new RegExp(`sha256: ${'a'.repeat(64)}`))
  assert.match(report, /github-release-0\.15\.0\.md \(4 B\) \(本地，不上传\)/)

  const empty = buildReport({
    version: '0.15.0',
    previousTag: '',
    commitRange: 'HEAD',
    commits: [],
    artifacts: [],
    uploadTarget: '',
  })
  assert.match(empty, /- \(not compiled\)/)
})
