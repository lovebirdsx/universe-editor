/*---------------------------------------------------------------------------------------------
 *  Tests for package-editor.mjs pure helpers. Run with `node --test`.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
import { defaultBundleDir, editorVersion, splitArgs } from '../package-editor.mjs'

test('splitArgs forwards electron-builder args and strips --env / --verify-root', () => {
  assert.deepEqual(splitArgs(['--win', 'nsis', 'dir', '--env', 'prod']), {
    builderArgs: ['--win', 'nsis', 'dir'],
    verifyRoot: undefined,
    bundleDir: undefined,
  })
  assert.deepEqual(splitArgs(['--win', 'nsis', '--env=prod']), {
    builderArgs: ['--win', 'nsis'],
    verifyRoot: undefined,
    bundleDir: undefined,
  })
  assert.deepEqual(
    splitArgs(['--win', 'dir', '--verify-root', 'release/linux-unpacked/resources']),
    {
      builderArgs: ['--win', 'dir'],
      verifyRoot: 'release/linux-unpacked/resources',
      bundleDir: undefined,
    },
  )
  assert.deepEqual(splitArgs(['--linux', 'dir', '--publish', 'never', '--verify-root=x/y']), {
    builderArgs: ['--linux', 'dir', '--publish', 'never'],
    verifyRoot: 'x/y',
    bundleDir: undefined,
  })
})

test('splitArgs leaves electron-builder args untouched when no --env / --verify-root', () => {
  assert.deepEqual(splitArgs(['--win', 'nsis']), {
    builderArgs: ['--win', 'nsis'],
    verifyRoot: undefined,
    bundleDir: undefined,
  })
})

test('splitArgs drops the separator pnpm forwards verbatim', () => {
  // `pnpm … package:win -- --env prod` delivers a literal `--`; electron-builder
  // would reject it, so it must never reach builderArgs.
  assert.deepEqual(splitArgs(['--', '--env', 'prod', '--win', 'dir']), {
    builderArgs: ['--win', 'dir'],
    verifyRoot: undefined,
    bundleDir: undefined,
  })
})

test('splitArgs strips --bundle-dir in both spellings', () => {
  assert.deepEqual(splitArgs(['--linux', 'dir', '--bundle-dir', 'out/notes']), {
    builderArgs: ['--linux', 'dir'],
    verifyRoot: undefined,
    bundleDir: 'out/notes',
  })
  assert.deepEqual(splitArgs(['--linux', 'dir', '--bundle-dir=out/notes']).bundleDir, 'out/notes')
})

test('defaultBundleDir lands in the release dir, above the unpacked app', () => {
  // Same target for both platforms: apps/editor/release/release-notes — the dir the
  // upload script reads. It must sit OUTSIDE the unpacked app (electron-builder wipes
  // the release dir before packaging, so the bundle is written afterwards).
  assert.equal(
    defaultBundleDir('apps/editor/release/linux-unpacked/resources'),
    join(repoRoot, 'apps/editor/release/release-notes'),
  )
  assert.equal(defaultBundleDir(undefined), join(repoRoot, 'apps/editor/release/release-notes'))
})

test('editorVersion reads the version being packaged from apps/editor', () => {
  assert.equal(
    editorVersion(),
    JSON.parse(readFileSync(join(repoRoot, 'apps/editor/package.json'), 'utf8')).version,
  )
})
