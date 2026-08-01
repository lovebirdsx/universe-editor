import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { listPackageFiles } from '../lib/packageFiles.js'

function makeExtension(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'uex-ls-'))
  mkdirSync(path.join(dir, 'dist', 'nested'), { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), '{}')
  writeFileSync(path.join(dir, 'dist', 'extension.js'), '')
  writeFileSync(path.join(dir, 'dist', 'nested', 'deep.js'), '')
  writeFileSync(path.join(dir, 'README.md'), '')
  return dir
}

describe('listPackageFiles', () => {
  it('expands the files whitelist recursively, sorted posix paths', async () => {
    const dir = makeExtension()
    const files = await listPackageFiles(dir, {
      name: 'x',
      version: '1.0.0',
      engines: { universe: '*' },
      main: 'dist/extension.js',
      files: ['dist'],
    })
    expect(files).toEqual(['README.md', 'dist/extension.js', 'dist/nested/deep.js', 'package.json'])
  })

  it('appends README/CHANGELOG only when present on disk', async () => {
    const dir = makeExtension()
    writeFileSync(path.join(dir, 'CHANGELOG.md'), '')
    const files = await listPackageFiles(dir, {
      name: 'x',
      version: '1.0.0',
      engines: { universe: '*' },
      main: 'dist/extension.js',
      files: ['dist'],
    })
    expect(files).toContain('CHANGELOG.md')
    expect(files.filter((f) => f === 'README.md')).toHaveLength(1)
  })

  it('skips whitelist entries missing from disk', async () => {
    const dir = makeExtension()
    const files = await listPackageFiles(dir, {
      name: 'x',
      version: '1.0.0',
      engines: { universe: '*' },
      files: ['dist', 'assets'],
    })
    expect(files.some((f) => f.startsWith('assets'))).toBe(false)
  })

  it('falls back to the dist default when files is absent', async () => {
    const dir = makeExtension()
    const files = await listPackageFiles(dir, {
      name: 'x',
      version: '1.0.0',
      engines: { universe: '*' },
      main: 'dist/extension.js',
    })
    expect(files).toContain('dist/extension.js')
  })
})
