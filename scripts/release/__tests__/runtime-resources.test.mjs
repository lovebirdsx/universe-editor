/*---------------------------------------------------------------------------------------------
 *  Tests for runtime-resources.mjs pure helpers. Run with `node --test`.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkTempDir } from '../../lib/temp-root.mjs'
import {
  discoverBuiltinExtensions,
  extensionPackageFiles,
  releaseNotesSource,
  resolveStagedProductJson,
  verifyReleaseNotesArtifacts,
} from '../runtime-resources.mjs'

const sha256OfText = (text) => createHash('sha256').update(text).digest('hex')

test('extensionPackageFiles defaults to dist for executable extensions', () => {
  assert.deepEqual(extensionPackageFiles({ main: 'dist/extension.js' }), ['package.json', 'dist'])
})

test('extensionPackageFiles supports explicit shipped directories', () => {
  assert.deepEqual(
    extensionPackageFiles({
      main: 'server/index.js',
      files: ['./server', 'syntaxes/**', 'themes'],
    }),
    ['package.json', 'server', 'syntaxes', 'themes'],
  )
})

test('extensionPackageFiles rejects paths outside the extension root', () => {
  assert.throws(() => extensionPackageFiles({ files: ['../secret'] }), /must stay inside/)
  assert.throws(() => extensionPackageFiles({ files: ['C:/secret'] }), /must stay inside/)
  assert.throws(() => extensionPackageFiles({ files: ['dist/*.js'] }), /must be a literal/)
})

test('discoverBuiltinExtensions finds package folders in stable order', () => {
  const root = mkdtempSync(join(tmpdir(), 'ue-runtime-resources-'))
  try {
    mkdirSync(join(root, 'zeta'))
    mkdirSync(join(root, 'alpha'))
    mkdirSync(join(root, 'notes'))
    writeFileSync(join(root, 'zeta/package.json'), JSON.stringify({ name: 'zeta' }), 'utf8')
    writeFileSync(join(root, 'alpha/package.json'), JSON.stringify({ name: 'alpha' }), 'utf8')

    assert.deepEqual(
      discoverBuiltinExtensions(root).map((extension) => extension.id),
      ['alpha', 'zeta'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// build/product.json 的形状：JSONC，带注释与 galleryUrl 占位值，无 configurationDefaults。
const PRODUCT_JSONC = [
  '{',
  '  // 打包版内嵌的产品默认配置',
  '  "galleryUrl": "http://gallery.example.com:9999/universe-editor"',
  '',
  '  // configurationDefaults 刻意不在此声明占位值',
  '}',
  '',
].join('\n')

test('resolveStagedProductJson: 无任何 env 时返回 undefined（调用方走字节级拷贝）', () => {
  assert.equal(resolveStagedProductJson(PRODUCT_JSONC, {}), undefined)
})

test('resolveStagedProductJson: 只配 configurationDefaults 时写入该字段且保留 galleryUrl 占位值', () => {
  const staged = JSON.parse(
    resolveStagedProductJson(PRODUCT_JSONC, { UE_SWARM_URL: 'http://swarm.example.com/' }),
  )
  assert.deepEqual(staged, {
    galleryUrl: 'http://gallery.example.com:9999/universe-editor',
    configurationDefaults: { 'perforce.swarm.url': 'http://swarm.example.com/' },
  })
})

test('resolveStagedProductJson: 只配 UE_GALLERY_URL 时不写 configurationDefaults 字段', () => {
  const staged = JSON.parse(
    resolveStagedProductJson(PRODUCT_JSONC, { UE_GALLERY_URL: 'http://gallery.example.com/g' }),
  )
  assert.equal(staged.galleryUrl, 'http://gallery.example.com/g')
  assert.equal('configurationDefaults' in staged, false)
})

test('resolveStagedProductJson: 两者都配时各自生效，产出以换行结尾的合法 JSON', () => {
  const text = resolveStagedProductJson(PRODUCT_JSONC, {
    UE_GALLERY_URL: 'http://gallery.example.com/g',
    UE_TRACKER_SERVER_URL: 'http://tracker.example.com:3030',
    UE_TRACKER_APP_URL: 'http://tracker.example.com',
  })
  assert.ok(text.endsWith('\n'))
  assert.deepEqual(JSON.parse(text), {
    galleryUrl: 'http://gallery.example.com/g',
    configurationDefaults: {
      'issueReporter.tracker.serverUrl': 'http://tracker.example.com:3030',
      'issueReporter.tracker.appUrl': 'http://tracker.example.com',
    },
  })
})

const NOTES_JSON = `${JSON.stringify(
  [
    { version: '0.15.0', date: '2026-10-10', title: '标题', summary: '摘要', body: '## 小节\n' },
    { version: '0.14.9', title: '', summary: '', body: '' },
  ],
  null,
  2,
)}\n`

function notesFixture() {
  const root = mkTempDir('ue-notes-artifacts-')
  mkdirSync(join(root, 'resources'), { recursive: true })
  writeFileSync(join(root, 'canonical.json'), NOTES_JSON, 'utf8')
  writeFileSync(join(root, 'resources/release-notes.json'), NOTES_JSON, 'utf8')
  return root
}

test('verifyReleaseNotesArtifacts accepts a package whose notes match the canonical bytes', () => {
  const root = notesFixture()
  try {
    const entries = verifyReleaseNotesArtifacts({
      resourcesRoot: join(root, 'resources'),
      canonicalPath: join(root, 'canonical.json'),
    })
    assert.deepEqual(
      entries.map((entry) => entry.version),
      ['0.15.0', '0.14.9'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('verifyReleaseNotesArtifacts rejects a package that drifted from canonical', () => {
  const root = notesFixture()
  try {
    writeFileSync(join(root, 'resources/release-notes.json'), '[]\n', 'utf8')
    assert.throws(
      () =>
        verifyReleaseNotesArtifacts({
          resourcesRoot: join(root, 'resources'),
          canonicalPath: join(root, 'canonical.json'),
        }),
      /与 canonical 不一致/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('verifyReleaseNotesArtifacts rejects a malformed or unordered payload', () => {
  const root = notesFixture()
  const packaged = join(root, 'resources/release-notes.json')
  const canonical = join(root, 'canonical.json')
  try {
    for (const [payload, pattern] of [
      ['{"not":"an array"}\n', /顶层不是数组/],
      ['[{"version":"0.15","title":"","summary":"","body":""}]\n', /version 非法/],
      ['[{"version":"0.15.0","title":"","summary":"","body":null}]\n', /body 不是字符串/],
      ['[{"version":"x","title":"","summary":"","body":""}]\n', /不是对象|version 非法/],
      [
        '[{"version":"0.14.0","title":"","summary":"","body":""},{"version":"0.15.0","title":"","summary":"","body":""}]\n',
        /未严格降序/,
      ],
    ]) {
      writeFileSync(packaged, payload, 'utf8')
      writeFileSync(canonical, payload, 'utf8')
      assert.throws(
        () =>
          verifyReleaseNotesArtifacts({
            resourcesRoot: join(root, 'resources'),
            canonicalPath: canonical,
          }),
        pattern,
        payload,
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('verifyReleaseNotesArtifacts ties the packaged JSON to the upload manifest', () => {
  const root = notesFixture()
  try {
    const bundleDir = join(root, 'bundle')
    mkdirSync(bundleDir, { recursive: true })
    const good = { artifacts: [{ path: 'release-notes.json', sha256: sha256OfText(NOTES_JSON) }] }
    writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify(good), 'utf8')
    verifyReleaseNotesArtifacts({
      resourcesRoot: join(root, 'resources'),
      canonicalPath: join(root, 'canonical.json'),
      bundleDir,
    })

    writeFileSync(
      join(bundleDir, 'manifest.json'),
      JSON.stringify({ artifacts: [{ path: 'release-notes.json', sha256: 'deadbeef' }] }),
      'utf8',
    )
    assert.throws(
      () =>
        verifyReleaseNotesArtifacts({
          resourcesRoot: join(root, 'resources'),
          canonicalPath: join(root, 'canonical.json'),
          bundleDir,
        }),
      /与安装包不一致/,
    )

    writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify({ artifacts: [] }), 'utf8')
    assert.throws(
      () =>
        verifyReleaseNotesArtifacts({
          resourcesRoot: join(root, 'resources'),
          canonicalPath: join(root, 'canonical.json'),
          bundleDir,
        }),
      /缺少 release-notes.json/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('verifyReleaseNotesArtifacts fails when a file is missing entirely', () => {
  const root = notesFixture()
  try {
    rmSync(join(root, 'canonical.json'))
    assert.throws(
      () =>
        verifyReleaseNotesArtifacts({
          resourcesRoot: join(root, 'resources'),
          canonicalPath: join(root, 'canonical.json'),
        }),
      /canonical release notes/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('releaseNotesSource picks the snapshot, refuses a stale tree, and degrades for old tags', () => {
  const root = mkTempDir('ue-notes-source-')
  try {
    const sourceDir = join(root, 'docs/release-notes')
    const snapshotPath = join(root, '.release-notes-build/release-notes.json')
    const canonicalPath = join(root, 'resources/release-notes.json')
    mkdirSync(join(root, 'resources'), { recursive: true })
    writeFileSync(canonicalPath, '[]\n', 'utf8')

    // A tag predating docs/release-notes: only the tracked JSON exists, and it ships as-is.
    assert.equal(
      releaseNotesSource({ sourceDir, snapshotPath, canonicalPath }).source,
      canonicalPath,
    )

    // Modern tree without a compile yet: fail with the command that fixes it.
    mkdirSync(sourceDir, { recursive: true })
    assert.throws(
      () => releaseNotesSource({ sourceDir, snapshotPath, canonicalPath }),
      /pnpm release:notes/,
    )

    mkdirSync(join(root, '.release-notes-build'), { recursive: true })
    writeFileSync(snapshotPath, '[]\n', 'utf8')
    assert.equal(
      releaseNotesSource({ sourceDir, snapshotPath, canonicalPath }).source,
      snapshotPath,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
