import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadNlsBundle, localizeManifest } from '../nls.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ue-nls-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('localizeManifest', () => {
  const bundle = { 'a.title': 'Alpha', 'b.label': '标签' }

  it('replaces a whole-string %key% placeholder with its translation', () => {
    expect(localizeManifest('%a.title%', bundle)).toBe('Alpha')
    expect(localizeManifest('%b.label%', bundle)).toBe('标签')
  })

  it('leaves a %key% with no bundle entry untouched (visible miss)', () => {
    expect(localizeManifest('%missing.key%', bundle)).toBe('%missing.key%')
  })

  it('does not touch plain strings or embedded percent signs', () => {
    expect(localizeManifest('Commit', bundle)).toBe('Commit')
    expect(localizeManifest('50% done', bundle)).toBe('50% done')
    expect(localizeManifest('${authorName} (100%)', bundle)).toBe('${authorName} (100%)')
  })

  it('walks nested objects and arrays, translating only values', () => {
    const manifest = {
      contributes: {
        commands: [
          { command: 'a', title: '%a.title%' },
          { command: 'b', title: '%b.label%', category: 'Git' },
        ],
      },
    }
    expect(localizeManifest(manifest, bundle)).toEqual({
      contributes: {
        commands: [
          { command: 'a', title: 'Alpha' },
          { command: 'b', title: '标签', category: 'Git' },
        ],
      },
    })
  })

  it('passes through non-string primitives', () => {
    expect(localizeManifest(42, bundle)).toBe(42)
    expect(localizeManifest(true, bundle)).toBe(true)
    expect(localizeManifest(null, bundle)).toBe(null)
  })
})

describe('loadNlsBundle', () => {
  async function writeNls(name: string, content: unknown): Promise<void> {
    await writeFile(join(dir, name), JSON.stringify(content), 'utf8')
  }

  it('returns undefined when the extension ships no nls files', async () => {
    expect(await loadNlsBundle(dir, 'zh-CN')).toBeUndefined()
  })

  it('loads the default bundle when no locale is requested', async () => {
    await writeNls('package.nls.json', { 'a.title': 'Alpha' })
    expect(await loadNlsBundle(dir)).toEqual({ 'a.title': 'Alpha' })
  })

  it('merges the locale bundle over the default (per-key fallback)', async () => {
    await writeNls('package.nls.json', { 'a.title': 'Alpha', 'b.title': 'Beta' })
    await writeNls('package.nls.zh-cn.json', { 'a.title': '甲' })
    expect(await loadNlsBundle(dir, 'zh-CN')).toEqual({ 'a.title': '甲', 'b.title': 'Beta' })
  })

  it('lowercases the locale to match the on-disk filename', async () => {
    await writeNls('package.nls.json', { 'a.title': 'Alpha' })
    await writeNls('package.nls.zh-cn.json', { 'a.title': '甲' })
    expect(await loadNlsBundle(dir, 'ZH-CN')).toEqual({ 'a.title': '甲' })
  })

  it('uses only the default bundle for an English locale (no en file expected)', async () => {
    await writeNls('package.nls.json', { 'a.title': 'Alpha' })
    expect(await loadNlsBundle(dir, 'en-US')).toEqual({ 'a.title': 'Alpha' })
  })

  it('falls back to the default bundle when the locale file is absent', async () => {
    await writeNls('package.nls.json', { 'a.title': 'Alpha' })
    expect(await loadNlsBundle(dir, 'fr-FR')).toEqual({ 'a.title': 'Alpha' })
  })
})
