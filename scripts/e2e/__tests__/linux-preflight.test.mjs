/*---------------------------------------------------------------------------------------------
 *  Tests for linux-preflight.mjs. Run with `node --test`.
 *
 *  Guard the two pure functions: parseLddMissingLibs must extract exactly the
 *  `=> not found` lines from real ldd output (tab-indented, mixed with normal
 *  `=> /lib/x.so (0x...)` lines), and decideFixMode must map the root / sudo /
 *  interactivity signals onto auto / interactive / manual without leaking a
 *  broken fix attempt into an agent (non-interactive) environment.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLddMissingLibs, decideFixMode } from '../linux-preflight.mjs'

test('parseLddMissingLibs extracts tab-indented `=> not found` lines', () => {
  const ldd = '\tlibnspr4.so => not found\n\tlibnss3.so => not found\n'
  assert.deepEqual(parseLddMissingLibs(ldd), ['libnspr4.so', 'libnss3.so'])
})

test('parseLddMissingLibs returns [] when nothing is missing', () => {
  const ldd = '\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f)\n'
  assert.deepEqual(parseLddMissingLibs(ldd), [])
})

test('parseLddMissingLibs dedupes and sorts', () => {
  const ldd = '\tzlib.so.1 => not found\n\tlibnspr4.so => not found\n\tzlib.so.1 => not found\n'
  assert.deepEqual(parseLddMissingLibs(ldd), ['libnspr4.so', 'zlib.so.1'])
})

test('parseLddMissingLibs handles empty input', () => {
  assert.deepEqual(parseLddMissingLibs(''), [])
})

test('parseLddMissingLibs ignores normal `=> /lib/x.so (0x...)` lines mixed with missing', () => {
  const ldd = [
    '\tlinux-vdso.so.1 (0x00007ffd)',
    '\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f)',
    '\tlibnspr4.so => not found',
  ].join('\n')
  assert.deepEqual(parseLddMissingLibs(ldd), ['libnspr4.so'])
})

test('decideFixMode: root → auto', () => {
  assert.equal(
    decideFixMode({ isRoot: true, hasPasswordlessSudo: false, isInteractive: false }),
    'auto',
  )
})

test('decideFixMode: passwordless sudo → auto', () => {
  assert.equal(
    decideFixMode({ isRoot: false, hasPasswordlessSudo: true, isInteractive: false }),
    'auto',
  )
})

test('decideFixMode: only interactive → interactive', () => {
  assert.equal(
    decideFixMode({ isRoot: false, hasPasswordlessSudo: false, isInteractive: true }),
    'interactive',
  )
})

test('decideFixMode: nothing → manual', () => {
  assert.equal(
    decideFixMode({ isRoot: false, hasPasswordlessSudo: false, isInteractive: false }),
    'manual',
  )
})
