/*---------------------------------------------------------------------------------------------
 *  Tests for the Claude / Codex flavor definitions: registry coordinates, tar
 *  extraction params, version-dir binary layout, and bundled-version discovery.
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CODEX_VERSION, codexFlavor, createClaudeFlavor } from '../flavors.js'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'universe-editor-agent-flavor-'))
  tempDirs.push(dir)
  return dir
}

describe('claude flavor', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('reads the bundled sdkVersion from claude-binary.json', async () => {
    const dir = await makeTempDir()
    const metaPath = path.join(dir, 'claude-binary.json')
    await writeFile(metaPath, JSON.stringify({ sdkVersion: '0.3.186' }))

    const flavor = createClaudeFlavor(() => metaPath)
    await expect(flavor.bundledVersion()).resolves.toBe('0.3.186')
  })

  it('throws when claude-binary.json is missing sdkVersion', async () => {
    const dir = await makeTempDir()
    const metaPath = path.join(dir, 'claude-binary.json')
    await writeFile(metaPath, JSON.stringify({}))

    const flavor = createClaudeFlavor(() => metaPath)
    await expect(flavor.bundledVersion()).rejects.toThrow(/missing sdkVersion/)
  })

  it('exposes claude registry coordinates and single-file extraction', () => {
    const platform = { suffix: 'win32-x64', binName: 'claude.exe' }
    const flavor = createClaudeFlavor(() => '/unused/claude-binary.json')

    expect(flavor.id).toBe('claude')
    expect(flavor.platformPackage(platform)).toBe('@anthropic-ai/claude-agent-sdk-win32-x64')
    expect(flavor.platformVersion('0.3.186', platform)).toBe('0.3.186')
    expect(flavor.latestPackage).toBe('@anthropic-ai/claude-agent-sdk')
    expect(flavor.binaryIn('/root/0.3.186', platform)).toBe(
      path.join('/root/0.3.186', 'claude.exe'),
    )

    const opts = flavor.extractOptions(platform)
    expect(opts.strip).toBe(1)
    expect(opts.filter('package/claude.exe')).toBe(true)
    expect(opts.filter('package/other')).toBe(false)
  })
})

describe('codex flavor', () => {
  it('pins the bundled version to the CODEX_VERSION constant', async () => {
    await expect(codexFlavor.bundledVersion()).resolves.toBe(CODEX_VERSION)
  })

  it('exposes codex registry coordinates and vendor-triple extraction', () => {
    const platform = {
      suffix: 'win32-x64',
      triple: 'x86_64-pc-windows-msvc',
      binName: 'codex.exe',
    }

    expect(codexFlavor.id).toBe('codex')
    expect(codexFlavor.platformPackage(platform)).toBe('@openai/codex')
    expect(codexFlavor.platformVersion('0.146.0', platform)).toBe('0.146.0-win32-x64')
    expect(codexFlavor.latestPackage).toBe('@openai/codex')
    expect(codexFlavor.binaryIn('/root/0.146.0', platform)).toBe(
      path.join('/root/0.146.0', 'bin', 'codex.exe'),
    )

    const opts = codexFlavor.extractOptions(platform)
    expect(opts.strip).toBe(3)
    expect(opts.filter('package/vendor/x86_64-pc-windows-msvc/bin/codex.exe')).toBe(true)
    expect(opts.filter('package/other')).toBe(false)
  })
})
