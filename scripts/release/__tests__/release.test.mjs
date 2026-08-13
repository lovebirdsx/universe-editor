/*---------------------------------------------------------------------------------------------
 *  Tests for release.mjs pure helpers. Run with `node --test`.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildReport,
  bumpVersion,
  commandName,
  compareVersions,
  parseArgs,
  readLatestYmlVersion,
  shouldUseShell,
} from '../release.mjs'

const releaseDir = dirname(fileURLToPath(import.meta.url))

test('upload.mjs 同步清单不再包含下载页 index.html（已改由 server:deploy 同步）', () => {
  // upload.mjs 是带顶层副作用的执行脚本（不可 import），用源文本断言同步清单的构成。
  const src = readFileSync(resolve(releaseDir, '..', 'upload.mjs'), 'utf8')
  // 正向对照：release-notes.json 仍由 upload 同步，确保读到的是上传清单那段。
  assert.match(src, /release-notes\.json/)
  assert.doesNotMatch(src, /download-page/)
})

test('parseArgs reads release mode and upload options', () => {
  assert.deepEqual(
    parseArgs([
      '--version',
      '0.2.0',
      '--dry-run',
      '--no-upload',
      '--host',
      '10.0.0.5',
      '--remote-os',
      'linux',
    ]),
    {
      version: '0.2.0',
      dryRun: true,
      noUpload: true,
      host: '10.0.0.5',
      remoteOs: 'linux',
    },
  )
})

test('parseArgs rejects unknown or missing values', () => {
  assert.throws(() => parseArgs(['--wat']), /无法识别参数/)
  assert.throws(() => parseArgs(['--version']), /缺少 --version 的值/)
  assert.throws(() => parseArgs(['oops']), /无法识别参数/)
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
