import { describe, expect, it } from 'vitest'
import { extensionPackageFiles, normalizePackageFileEntry } from '../packageFiles.js'

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

  it('normalizes ./ prefixes, backslashes and /** suffixes', () => {
    expect(normalizePackageFileEntry('./dist/**')).toBe('dist')
    expect(normalizePackageFileEntry('assets\\img')).toBe('assets/img')
  })

  it('rejects entries escaping the extension directory', () => {
    expect(() => normalizePackageFileEntry('../secrets')).toThrow(/stay inside/)
    expect(() => normalizePackageFileEntry('/etc/passwd')).toThrow(/stay inside/)
    expect(() => normalizePackageFileEntry('C:/win')).toThrow(/stay inside/)
  })

  it('rejects glob entries', () => {
    expect(() => normalizePackageFileEntry('dist/*.js')).toThrow(/literal file or directory/)
  })
})
