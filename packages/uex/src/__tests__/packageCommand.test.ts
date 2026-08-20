import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { readVsixManifest } from '@universe-editor/extension-packaging'
import { runPackage } from '../commands/package.js'
import { UexError } from '../errors.js'

function makeExtension(overrides: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'uex-pkg-'))
  mkdirSync(path.join(dir, 'dist'), { recursive: true })
  writeFileSync(path.join(dir, 'dist', 'extension.js'), 'export {}')
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'demo',
      version: '1.0.0',
      publisher: 'acme',
      main: 'dist/extension.js',
      engines: { universe: '>=0.1.0 <1.0.0' },
      files: ['dist'],
      ...overrides,
    }),
  )
  return dir
}

describe('runPackage', () => {
  it('creates <publisher>.<name>-<version>.vsix that readVsixManifest round-trips', async () => {
    const dir = makeExtension()
    const { vsixPath } = await runPackage({ cwd: dir })
    expect(path.basename(vsixPath)).toBe('acme.demo-1.0.0.vsix')
    expect(existsSync(vsixPath)).toBe(true)
    const manifest = readVsixManifest(vsixPath)
    expect(manifest.publisher).toBe('acme')
    expect(manifest.name).toBe('demo')
    expect(manifest.version).toBe('1.0.0')
  })

  it('refuses when publisher is missing, with a fix-it hint', async () => {
    const dir = makeExtension({ publisher: undefined })
    const err = await runPackage({ cwd: dir }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UexError)
  })

  it('refuses when the entry point is missing', async () => {
    const dir = makeExtension({ main: 'dist/nope.js' })
    const err = await runPackage({ cwd: dir }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UexError)
    expect((err as UexError).message).toContain('dist/nope.js')
    expect((err as UexError).hints.join(' ')).toContain('npm run build')
  })

  it('blocks when engines.universe does not cover the current editor version', async () => {
    const dir = makeExtension({ engines: { universe: '>=0.9.0 <0.12.0' } })
    const err = await runPackage({ cwd: dir }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UexError)
  })

  it('--force downgrades the coverage error and still packages', async () => {
    const dir = makeExtension({ engines: { universe: '>=0.9.0 <0.12.0' } })
    const { vsixPath } = await runPackage({ cwd: dir, force: true })
    expect(existsSync(vsixPath)).toBe(true)
  })

  it('refuses outside an extension root', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'uex-pkg-empty-'))
    await expect(runPackage({ cwd: dir })).rejects.toBeInstanceOf(UexError)
  })
})
