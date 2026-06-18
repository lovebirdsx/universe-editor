import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanExtensions } from '../extensionScanner.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ue-scan-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function writeExtension(name: string, manifest: unknown): Promise<void> {
  const root = join(dir, name)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest), 'utf8')
}

const goodManifest = {
  name: 'good',
  version: '1.0.0',
  main: 'dist/extension.js',
  engines: { universe: '^0.1.0' },
  activationEvents: ['*'],
}

describe('scanExtensions', () => {
  it('returns [] for a non-existent directory', async () => {
    expect(await scanExtensions(join(dir, 'nope'))).toEqual([])
  })

  it('scans a valid extension and resolves its main path', async () => {
    await writeExtension('good', goodManifest)
    const [ext, ...rest] = await scanExtensions(dir)
    expect(rest).toHaveLength(0)
    expect(ext?.id).toBe('good')
    expect(ext?.mainPath).toBe(join(dir, 'good', 'dist', 'extension.js'))
  })

  it('derives id from publisher.name when a publisher is present', async () => {
    await writeExtension('pub', { ...goodManifest, name: 'git', publisher: 'universe' })
    const [ext] = await scanExtensions(dir)
    expect(ext?.id).toBe('universe.git')
  })

  it('skips a folder with an invalid manifest but keeps the rest', async () => {
    await writeExtension('good', goodManifest)
    await writeExtension('bad', { name: 'bad' }) // missing version + engines
    await writeFile(join(dir, 'loose.txt'), 'not a folder', 'utf8')
    const ids = (await scanExtensions(dir)).map((e) => e.id)
    expect(ids).toEqual(['good'])
  })

  it('omits mainPath for a declaration-only extension', async () => {
    const { main: _omit, ...noMain } = goodManifest
    await writeExtension('decl', noMain)
    const [ext] = await scanExtensions(dir)
    expect(ext?.mainPath).toBeUndefined()
  })

  it('keeps an extension whose engines.universe satisfies the host API version', async () => {
    await writeExtension('good', goodManifest) // engines.universe ^0.1.0
    const ids = (await scanExtensions(dir, '0.1.5')).map((e) => e.id)
    expect(ids).toEqual(['good'])
  })

  it('skips an extension whose engines.universe is incompatible with the host', async () => {
    await writeExtension('good', goodManifest) // ^0.1.0
    await writeExtension('future', {
      ...goodManifest,
      name: 'future',
      engines: { universe: '^2.0.0' },
    })
    const ids = (await scanExtensions(dir, '0.1.5')).map((e) => e.id)
    expect(ids).toEqual(['good'])
  })

  it('does not enforce engines when no host API version is provided', async () => {
    await writeExtension('future', {
      ...goodManifest,
      name: 'future',
      engines: { universe: '^2.0.0' },
    })
    const ids = (await scanExtensions(dir)).map((e) => e.id)
    expect(ids).toEqual(['future'])
  })

  it('reads + inlines jsonValidation schema files, normalizing fileMatch to an array', async () => {
    const root = join(dir, 'gc')
    await mkdir(join(root, 'schemas'), { recursive: true })
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        ...goodManifest,
        name: 'gc',
        contributes: {
          jsonValidation: [{ fileMatch: '**/*.entity.json', url: './schemas/entity.json' }],
        },
      }),
      'utf8',
    )
    await writeFile(
      join(root, 'schemas', 'entity.json'),
      JSON.stringify({ type: 'object', required: ['id'] }),
      'utf8',
    )
    const [ext] = await scanExtensions(dir)
    expect(ext?.resolvedJsonValidation).toEqual([
      { fileMatch: ['**/*.entity.json'], schema: { type: 'object', required: ['id'] } },
    ])
  })

  it('skips a jsonValidation entry whose schema file is missing, keeping the extension', async () => {
    await writeExtension('gc', {
      ...goodManifest,
      name: 'gc',
      contributes: {
        jsonValidation: [{ fileMatch: ['**/*.entity.json'], url: './schemas/missing.json' }],
      },
    })
    const [ext, ...rest] = await scanExtensions(dir)
    expect(rest).toHaveLength(0)
    expect(ext?.id).toBe('gc')
    expect(ext?.resolvedJsonValidation).toBeUndefined()
  })

  it('passes an http(s) jsonValidation url through unresolved (no disk read)', async () => {
    await writeExtension('gc', {
      ...goodManifest,
      name: 'gc',
      contributes: {
        jsonValidation: [
          { fileMatch: '**/.claude/settings.json', url: 'https://example.com/schema.json' },
        ],
      },
    })
    const [ext] = await scanExtensions(dir)
    expect(ext?.resolvedJsonValidation).toEqual([
      { fileMatch: ['**/.claude/settings.json'], url: 'https://example.com/schema.json' },
    ])
  })
})
