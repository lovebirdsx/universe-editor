/*---------------------------------------------------------------------------------------------
 *  Tests for package-editor.mjs pure helpers. Run with `node --test`.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitArgs } from '../package-editor.mjs'

test('splitArgs forwards electron-builder args and strips --env / --verify-root', () => {
  assert.deepEqual(splitArgs(['--win', 'nsis', 'dir', '--env', 'prod']), {
    builderArgs: ['--win', 'nsis', 'dir'],
    verifyRoot: undefined,
  })
  assert.deepEqual(splitArgs(['--win', 'nsis', '--env=prod']), {
    builderArgs: ['--win', 'nsis'],
    verifyRoot: undefined,
  })
  assert.deepEqual(
    splitArgs(['--win', 'dir', '--verify-root', 'release/linux-unpacked/resources']),
    {
      builderArgs: ['--win', 'dir'],
      verifyRoot: 'release/linux-unpacked/resources',
  })
  assert.deepEqual(splitArgs(['--linux', 'dir', '--publish', 'never', '--verify-root=x/y']), {
    builderArgs: ['--linux', 'dir', '--publish', 'never'],
    verifyRoot: 'x/y',
  })
})

test('splitArgs leaves electron-builder args untouched when no --env / --verify-root', () => {
  assert.deepEqual(splitArgs(['--win', 'nsis']), {
    builderArgs: ['--win', 'nsis'],
    verifyRoot: undefined,
  })
})
