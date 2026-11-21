import { describe, expect, it } from 'vitest'
import {
  extensionPackageFiles,
  isPathCoveredByPackageFiles,
  normalizePackageFileEntry,
} from '../packageFiles.js'

describe('extensionPackageFiles', () => {
  it('always includes package.json and defaults to dist when main is set', () => {
    expect(extensionPackageFiles({ main: 'dist/extension.js' })).toEqual(['package.json', 'dist'])
  })

  it('includes only package.json when there is no main and no files', () => {
    expect(extensionPackageFiles({})).toEqual(['package.json'])
  })

  it('uses manifest files[] over the dist default and dedupes', () => {
    expect(
      extensionPackageFiles({ main: 'dist/extension.js', files: ['dist', 'assets', 'icon.png'] }),
    ).toEqual(['package.json', 'dist', 'assets', 'icon.png'])
  })

  it('normalizes ./ prefixes, backslashes, trailing slashes and /** suffixes', () => {
    expect(normalizePackageFileEntry('./dist/**')).toBe('dist')
    expect(normalizePackageFileEntry('assets\\img')).toBe('assets/img')
    expect(normalizePackageFileEntry('dist/')).toBe('dist')
    expect(normalizePackageFileEntry('./')).toBe('.')
    expect(normalizePackageFileEntry('.')).toBe('.')
  })

  it('rejects entries escaping the extension directory', () => {
    expect(() => normalizePackageFileEntry('../secrets')).toThrow(/stay inside/)
    expect(() => normalizePackageFileEntry('/etc/passwd')).toThrow(/stay inside/)
    expect(() => normalizePackageFileEntry('C:/win')).toThrow(/stay inside/)
  })

  it('rejects glob entries', () => {
    expect(() => normalizePackageFileEntry('dist/*.js')).toThrow(/literal file or directory/)
  })

  it('defaults to dist when only trusted views ship code', () => {
    expect(extensionPackageFiles({ contributes: { trustedViews: [{ id: 'a.b' }] } })).toEqual([
      'package.json',
      'dist',
    ])
  })
})

describe('isPathCoveredByPackageFiles', () => {
  const files = ['package.json', 'dist', 'assets/icon.png']

  it('accepts the entry itself and paths below a listed directory', () => {
    expect(isPathCoveredByPackageFiles(files, 'dist/renderer/status.js')).toBe(true)
    expect(isPathCoveredByPackageFiles(files, './dist/renderer/status.js')).toBe(true)
    expect(isPathCoveredByPackageFiles(files, 'assets/icon.png')).toBe(true)
    expect(isPathCoveredByPackageFiles(files, 'assets\\icon.png')).toBe(true)
  })

  it('rejects paths outside the whitelist', () => {
    expect(isPathCoveredByPackageFiles(files, 'src/status.js')).toBe(false)
    expect(isPathCoveredByPackageFiles(files, 'assets/other.png')).toBe(false)
    expect(isPathCoveredByPackageFiles(files, '')).toBe(false)
  })

  it('normalizes both sides the same way', () => {
    expect(isPathCoveredByPackageFiles(['./dist/**'], 'dist/renderer/status.js')).toBe(true)
    expect(isPathCoveredByPackageFiles(['assets\\'], 'assets/icon.png')).toBe(true)
    expect(isPathCoveredByPackageFiles(['./dist/'], './dist/renderer/status.js')).toBe(true)
  })

  it('treats "." / "./" as covering the whole extension', () => {
    expect(isPathCoveredByPackageFiles(['.'], 'dist/renderer/status.js')).toBe(true)
    expect(isPathCoveredByPackageFiles(['./'], 'assets/icon.png')).toBe(true)
  })

  it('keeps path comparison case-sensitive', () => {
    // VSIX zip paths are matched byte-for-byte; Windows case folding must not
    // make a mismatched entry pass here.
    expect(isPathCoveredByPackageFiles(['dist'], 'Dist/renderer/status.js')).toBe(false)
    expect(isPathCoveredByPackageFiles(['Dist'], 'dist/renderer/status.js')).toBe(false)
  })
})
