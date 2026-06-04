/*---------------------------------------------------------------------------------------------
 *  Tests for runtime-resources.mjs pure helpers. Run with `node --test`.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { discoverBuiltinExtensions, extensionPackageFiles } from '../runtime-resources.mjs'

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
