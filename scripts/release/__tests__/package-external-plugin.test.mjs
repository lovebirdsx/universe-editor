/*---------------------------------------------------------------------------------------------
 *  Tests for package-external-plugin.mjs payload validation. Run with `node --test`.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir } from '../../lib/temp-root.mjs'
import { validateExtensionPayload } from '../package-external-plugin.mjs'

function withExtension(files, run) {
  const dir = mkTempDir('ue-ext-plugin-')
  try {
    for (const relative of files) {
      const file = join(dir, relative)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, '')
    }
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

test('accepts main and trusted-view entries covered by files', () => {
  withExtension(['dist/extension.js', 'dist/renderer/status.js'], (dir) => {
    const errors = validateExtensionPayload(dir, {
      main: './dist/extension.js',
      files: ['dist'],
      contributes: {
        trustedViews: [{ id: 'acme.status', entry: './dist/renderer/status.js' }],
      },
    })
    assert.deepEqual(errors, [])
  })
})

test('defaults to dist when no files list is given', () => {
  withExtension(['dist/extension.js', 'dist/renderer/status.js'], (dir) => {
    const errors = validateExtensionPayload(dir, {
      main: './dist/extension.js',
      contributes: {
        trustedViews: [{ id: 'acme.status', entry: './dist/renderer/status.js' }],
      },
    })
    assert.deepEqual(errors, [])
  })
})

test('rejects a main entry that does not exist on disk', () => {
  withExtension(['dist/other.js'], (dir) => {
    const errors = validateExtensionPayload(dir, {
      main: './dist/extension.js',
      files: ['dist'],
    })
    assert.equal(errors.length, 1)
    assert.match(errors[0], /main "\.\/dist\/extension\.js" does not exist/)
  })
})

test('rejects entries missing from the files whitelist', () => {
  withExtension(['dist/extension.js', 'dist/renderer/status.js'], (dir) => {
    const errors = validateExtensionPayload(dir, {
      main: './dist/extension.js',
      files: ['assets'],
      contributes: {
        trustedViews: [{ id: 'acme.status', entry: './dist/renderer/status.js' }],
      },
    })
    assert.equal(errors.length, 2)
    assert.match(errors[0], /main .* not covered by the package files whitelist/)
    assert.match(errors[1], /trustedViews "acme\.status".* not covered/)
  })
})

test('treats "." as covering the whole extension', () => {
  withExtension(['dist/extension.js', 'dist/renderer/status.js'], (dir) => {
    const errors = validateExtensionPayload(dir, {
      main: './dist/extension.js',
      files: ['.'],
      contributes: {
        trustedViews: [{ id: 'acme.status', entry: './dist/renderer/status.js' }],
      },
    })
    assert.equal(errors.length, 0)
  })
})
