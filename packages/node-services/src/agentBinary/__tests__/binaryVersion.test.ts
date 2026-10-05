/*---------------------------------------------------------------------------------------------
 *  Tests for the binary version helpers: strict parsing, semver precedence, the
 *  per-agent `--version` banners, and the never-rejecting probe.
 *--------------------------------------------------------------------------------------------*/

import { chmod, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  compareBinaryVersions,
  parseBinaryVersion,
  parseVersionOutput,
  probeBinaryVersion,
} from '../binaryVersion.js'
import { mkTempDir } from '@universe-editor/temp-root'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = mkTempDir('universe-editor-binary-version-')
  tempDirs.push(dir)
  return dir
}

function cmp(a: string, b: string): number {
  const left = parseBinaryVersion(a)
  const right = parseBinaryVersion(b)
  expect(left).not.toBeNull()
  expect(right).not.toBeNull()
  return compareBinaryVersions(left!, right!)
}

describe('parseBinaryVersion', () => {
  it('parses plain, v-prefixed and prerelease versions', () => {
    expect(parseBinaryVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
    expect(parseBinaryVersion(' v0.159.1 ')).toEqual({
      major: 0,
      minor: 159,
      patch: 1,
      prerelease: [],
    })
    expect(parseBinaryVersion('1.2.3-beta.1+build.9')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ['beta', '1'],
    })
  })

  it('rejects anything that is not exactly one version', () => {
    // Strictness is the point: these all reach the floor check as path-like or
    // human strings, and a substring match would turn "1.2.3.4" into a version.
    expect(parseBinaryVersion('2.1.220 (Claude Code)')).toBeNull()
    expect(parseBinaryVersion('1.2')).toBeNull()
    expect(parseBinaryVersion('1.2.3.4')).toBeNull()
    expect(parseBinaryVersion('latest')).toBeNull()
    expect(parseBinaryVersion('')).toBeNull()
  })
})

describe('compareBinaryVersions', () => {
  it('orders numeric fields numerically, not lexically', () => {
    expect(cmp('1.2.3', '1.2.10')).toBeLessThan(0)
    expect(cmp('0.159.1', '0.160.0')).toBeLessThan(0)
    expect(cmp('2.0.0', '1.99.99')).toBeGreaterThan(0)
    expect(cmp('1.2.3', '1.2.3')).toBe(0)
  })

  it('sorts a prerelease below its release', () => {
    expect(cmp('0.159.1-rc.1', '0.159.1')).toBeLessThan(0)
    expect(cmp('1.2.3-alpha', '1.2.3-beta')).toBeLessThan(0)
    expect(cmp('1.2.3-1', '1.2.3-alpha')).toBeLessThan(0)
    expect(cmp('1.2.3-alpha', '1.2.3-alpha.1')).toBeLessThan(0)
    expect(cmp('1.2.3-rc.2', '1.2.3-rc.10')).toBeLessThan(0)
  })

  it('ignores build metadata', () => {
    expect(cmp('1.2.3+build.1', '1.2.3+build.2')).toBe(0)
    expect(cmp('1.2.3-beta+build', '1.2.3-beta')).toBe(0)
  })
})

describe('parseVersionOutput', () => {
  it('reads the claude CLI banner', () => {
    expect(parseVersionOutput('claude', '2.1.220 (Claude Code)\n')).toBe('2.1.220')
  })

  it('reads the codex CLI banner', () => {
    expect(parseVersionOutput('codex', 'codex-cli 0.145.0\n')).toBe('0.145.0')
  })

  it('falls back to the first semver token for an unexpected banner', () => {
    // A wrapper script or a reworded banner must not read as "no version".
    expect(parseVersionOutput('claude', 'Claude Code v1.2.3\n')).toBe('1.2.3')
    expect(parseVersionOutput('codex', 'codex 0.145.0 (build abc)\n')).toBe('0.145.0')
  })

  it('returns null when nothing parses', () => {
    expect(parseVersionOutput('codex', 'command not found\n')).toBeNull()
    expect(parseVersionOutput('claude', 'version 1.2.3.4\n')).toBeNull()
    expect(parseVersionOutput('claude', '')).toBeNull()
  })
})

describe('probeBinaryVersion', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('reports the version a real executable prints', async () => {
    // node is a stand-in for "some binary that answers --version"; the flavor id
    // only steers banner recognition, and the generic fallback covers it.
    await expect(probeBinaryVersion(process.execPath, 'codex')).resolves.toMatch(/^\d+\.\d+\.\d+/)
  })

  it('returns null for a path that does not exist, without throwing', async () => {
    const dir = await makeTempDir()
    await expect(probeBinaryVersion(path.join(dir, 'nope'), 'codex')).resolves.toBeNull()
  })

  it.skipIf(process.platform === 'win32')(
    'returns null when the binary hangs past the timeout',
    async () => {
      const dir = await makeTempDir()
      const script = path.join(dir, 'slow-codex')
      await writeFile(script, '#!/bin/sh\nsleep 30\n')
      await chmod(script, 0o755)

      await expect(probeBinaryVersion(script, 'codex', { timeoutMs: 250 })).resolves.toBeNull()
    },
  )

  it.skipIf(process.platform === 'win32')('returns null for a non-executable file', async () => {
    const dir = await makeTempDir()
    const plain = path.join(dir, 'codex.txt')
    await writeFile(plain, 'codex-cli 0.145.0\n')

    await expect(probeBinaryVersion(plain, 'codex')).resolves.toBeNull()
  })
})
