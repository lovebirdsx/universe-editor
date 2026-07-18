import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
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
    expect(await scanExtensions(join(dir, 'nope'), false)).toEqual([])
  })

  it('scans a valid extension and resolves its main path', async () => {
    await writeExtension('good', goodManifest)
    const [ext, ...rest] = await scanExtensions(dir, false)
    expect(rest).toHaveLength(0)
    expect(ext?.id).toBe('good')
    expect(ext?.mainPath).toBe(join(dir, 'good', 'dist', 'extension.js'))
  })

  it('follows a symlinked/junctioned extension dir (dev/e2e --extensionDevelopmentPath model)', async () => {
    // A real extension outside the scan dir, linked in as a directory symlink.
    const outside = await mkdtemp(join(tmpdir(), 'ue-scan-ext-'))
    await mkdir(join(outside, 'linked-ext'), { recursive: true })
    await writeFile(
      join(outside, 'linked-ext', 'package.json'),
      JSON.stringify({ ...goodManifest, name: 'linked' }),
      'utf8',
    )
    try {
      // 'junction' works on Windows without admin; the type arg is ignored elsewhere.
      await symlink(join(outside, 'linked-ext'), join(dir, 'linked-ext'), 'junction')
    } catch {
      // Some sandboxes forbid symlink creation; skip rather than fail spuriously.
      await rm(outside, { recursive: true, force: true })
      return
    }
    const ids = (await scanExtensions(dir, false)).map((e) => e.id)
    expect(ids).toContain('linked')
    await rm(outside, { recursive: true, force: true })
  })

  it('marks results with the builtin flag passed to the scan', async () => {
    await writeExtension('good', goodManifest)
    const [builtin] = await scanExtensions(dir, true)
    expect(builtin?.builtin).toBe(true)
    const [user] = await scanExtensions(dir, false)
    expect(user?.builtin).toBe(false)
  })

  it('parses capabilities.untrustedWorkspaces from the manifest', async () => {
    await writeExtension('trust', {
      ...goodManifest,
      name: 'trust',
      capabilities: {
        untrustedWorkspaces: { supported: false, description: 'needs trust' },
      },
    })
    const [ext] = await scanExtensions(dir, false)
    expect(ext?.manifest.capabilities?.untrustedWorkspaces).toEqual({
      supported: false,
      description: 'needs trust',
    })
  })

  it('derives id from publisher.name when a publisher is present', async () => {
    await writeExtension('pub', { ...goodManifest, name: 'git', publisher: 'universe' })
    const [ext] = await scanExtensions(dir, false)
    expect(ext?.id).toBe('universe.git')
  })

  it('skips a folder with an invalid manifest but keeps the rest', async () => {
    await writeExtension('good', goodManifest)
    await writeExtension('bad', { name: 'bad' }) // missing version + engines
    await writeFile(join(dir, 'loose.txt'), 'not a folder', 'utf8')
    const ids = (await scanExtensions(dir, false)).map((e) => e.id)
    expect(ids).toEqual(['good'])
  })

  it('skips a folder being deleted (.vsctmp rename target)', async () => {
    await writeExtension('good', goodManifest)
    // A rename-then-delete in progress leaves a `<id>-<ver>.<hash>.vsctmp` folder
    // that still has a valid manifest; the scanner must not re-adopt it.
    await writeExtension('acme.sample-1.0.0.abc123.vsctmp', { ...goodManifest, name: 'stale' })
    const ids = (await scanExtensions(dir, false)).map((e) => e.id)
    expect(ids).toEqual(['good'])
  })

  it('omits mainPath for a declaration-only extension', async () => {
    const { main: _omit, ...noMain } = goodManifest
    await writeExtension('decl', noMain)
    const [ext] = await scanExtensions(dir, false)
    expect(ext?.mainPath).toBeUndefined()
  })

  it('keeps an extension whose engines.universe satisfies the host API version', async () => {
    await writeExtension('good', goodManifest) // engines.universe ^0.1.0
    const ids = (await scanExtensions(dir, false, '0.1.5')).map((e) => e.id)
    expect(ids).toEqual(['good'])
  })

  it('skips an extension whose engines.universe is incompatible with the host', async () => {
    await writeExtension('good', goodManifest) // ^0.1.0
    await writeExtension('future', {
      ...goodManifest,
      name: 'future',
      engines: { universe: '^2.0.0' },
    })
    const ids = (await scanExtensions(dir, false, '0.1.5')).map((e) => e.id)
    expect(ids).toEqual(['good'])
  })

  it('does not enforce engines when no host API version is provided', async () => {
    await writeExtension('future', {
      ...goodManifest,
      name: 'future',
      engines: { universe: '^2.0.0' },
    })
    const ids = (await scanExtensions(dir, false)).map((e) => e.id)
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
    const [ext] = await scanExtensions(dir, false)
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
    const [ext, ...rest] = await scanExtensions(dir, false)
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
    const [ext] = await scanExtensions(dir, false)
    expect(ext?.resolvedJsonValidation).toEqual([
      { fileMatch: ['**/.claude/settings.json'], url: 'https://example.com/schema.json' },
    ])
  })

  it('localizes %key% manifest placeholders against package.nls.<locale>.json', async () => {
    const root = join(dir, 'loc')
    await mkdir(root, { recursive: true })
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        ...goodManifest,
        name: 'loc',
        contributes: { commands: [{ command: 'loc.hi', title: '%loc.hi.title%' }] },
      }),
      'utf8',
    )
    await writeFile(
      join(root, 'package.nls.json'),
      JSON.stringify({ 'loc.hi.title': 'Hi' }),
      'utf8',
    )
    await writeFile(
      join(root, 'package.nls.zh-cn.json'),
      JSON.stringify({ 'loc.hi.title': '你好' }),
      'utf8',
    )

    const [zh] = await scanExtensions(dir, false, undefined, 'zh-CN')
    expect(zh?.manifest.contributes?.commands?.[0]?.title).toBe('你好')

    const [en] = await scanExtensions(dir, false, undefined, 'en-US')
    expect(en?.manifest.contributes?.commands?.[0]?.title).toBe('Hi')

    const [dflt] = await scanExtensions(dir, false)
    expect(dflt?.manifest.contributes?.commands?.[0]?.title).toBe('Hi')
  })
})
