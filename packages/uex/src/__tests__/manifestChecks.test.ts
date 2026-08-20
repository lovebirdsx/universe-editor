import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { checkManifestForPublish, type PublishManifest } from '../lib/manifestChecks.js'

function fixture(): { dir: string; base: PublishManifest } {
  const dir = mkdtempSync(path.join(tmpdir(), 'uex-checks-'))
  mkdirSync(path.join(dir, 'dist'), { recursive: true })
  writeFileSync(path.join(dir, 'dist', 'extension.js'), '')
  writeFileSync(path.join(dir, 'icon.png'), '')
  const base: PublishManifest = {
    name: 'demo',
    version: '1.2.3',
    publisher: 'acme',
    main: 'dist/extension.js',
    engines: { universe: '>=0.7.0 <1.0.0' },
    files: ['dist', 'icon.png'],
  }
  return { dir, base }
}

const ctx = (dir: string) => ({ extensionDir: dir, currentApiVersion: '0.7.1' })

describe('checkManifestForPublish', () => {
  it('passes a well-formed manifest', () => {
    const { dir, base } = fixture()
    expect(checkManifestForPublish(base, ctx(dir))).toEqual([])
  })

  it('errors on missing publisher', () => {
    const { dir, base } = fixture()
    const issues = checkManifestForPublish({ ...base, publisher: undefined }, ctx(dir))
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ level: 'error' })
    expect(issues[0]!.hint).toContain('publisher')
  })

  it('errors on missing or empty files whitelist', () => {
    const { dir, base } = fixture()
    for (const files of [undefined, []] as const) {
      const issues = checkManifestForPublish({ ...base, files }, ctx(dir))
      expect(issues.some((i) => i.level === 'error' && i.message.includes('"files"'))).toBe(true)
    }
  })

  it('errors on non x.y.z versions', () => {
    const { dir, base } = fixture()
    const issues = checkManifestForPublish({ ...base, version: '1.2.3-beta.1' }, ctx(dir))
    expect(issues.some((i) => i.level === 'error' && i.message.includes('"version"'))).toBe(true)
  })

  it.each(['>=0.1.0 || >=0.2.0', '0.1.0 - 1.0.0'])(
    'errors on unsupported range forms: %s',
    (range) => {
      const { dir, base } = fixture()
      const issues = checkManifestForPublish({ ...base, engines: { universe: range } }, ctx(dir))
      expect(
        issues.some((i) => i.level === 'error' && i.message.includes('engines.universe')),
      ).toBe(true)
    },
  )

  it('errors when engines.universe does not cover the current editor version', () => {
    const { dir, base } = fixture()
    const issues = checkManifestForPublish(
      { ...base, engines: { universe: '>=0.9.0 <1.0.0' } },
      ctx(dir),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ level: 'error', code: 'engine-coverage' })
    expect(issues[0]!.message).toContain('editor version')
  })

  it('--force downgrades the coverage error to a warning', () => {
    const { dir, base } = fixture()
    const issues = checkManifestForPublish(
      { ...base, engines: { universe: '>=0.9.0 <1.0.0' } },
      { ...ctx(dir), force: true },
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ level: 'warning', code: 'engine-coverage' })
  })

  it('errors on unknown categories and lists the valid ones', () => {
    const { dir, base } = fixture()
    const issues = checkManifestForPublish({ ...base, categories: ['Bogus'] }, ctx(dir))
    expect(issues.some((i) => i.level === 'error' && i.message.includes('Bogus'))).toBe(true)
    expect(issues[0]!.hint).toContain('Other')
  })

  it('warns on files entries missing from disk', () => {
    const { dir, base } = fixture()
    const issues = checkManifestForPublish({ ...base, files: ['dist', 'nope.txt'] }, ctx(dir))
    expect(issues.some((i) => i.level === 'warning' && i.message.includes('nope.txt'))).toBe(true)
  })

  it('warns on a missing icon file', () => {
    const { dir, base } = fixture()
    const issues = checkManifestForPublish({ ...base, icon: 'missing.png' }, ctx(dir))
    expect(issues.some((i) => i.level === 'warning' && i.message.includes('missing.png'))).toBe(
      true,
    )
  })

  it('warns on onCommand activation without a matching contribution', () => {
    const { dir, base } = fixture() as { dir: string; base: PublishManifest }
    const issues = checkManifestForPublish(
      {
        ...base,
        activationEvents: ['onCommand:demo.hello'],
        contributes: { commands: [{ command: 'demo.other', title: 'Other' }] },
      },
      ctx(dir),
    )
    expect(
      issues.some((i) => i.level === 'warning' && i.message.includes('onCommand:demo.hello')),
    ).toBe(true)
  })

  it('aggregates multiple errors in stable order (identity before range)', () => {
    const { dir, base } = fixture()
    const issues = checkManifestForPublish(
      { ...base, publisher: undefined, files: undefined, version: 'x' },
      ctx(dir),
    )
    const errors = issues.filter((i) => i.level === 'error')
    expect(errors.map((e) => e.message)).toEqual([
      'manifest is missing "publisher"',
      'manifest is missing "files" (the VSIX whitelist)',
      '"version" must be a plain x.y.z version, got "x"',
    ])
  })
})
