import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import AdmZip from 'adm-zip'
import { readVsixManifest, extractVsix, createVsix } from '../vsix.js'

const validManifest = {
  name: 'sample',
  publisher: 'acme',
  version: '1.2.3',
  engines: { universe: '^0.1.0' },
  main: 'dist/extension.js',
  contributes: { commands: [{ command: 'sample.hello', title: 'Sample: Hello' }] },
}

/** Build an in-memory VSIX (zip) with the given `extension/**` files. */
function buildVsix(files: Record<string, string>): Buffer {
  const zip = new AdmZip()
  // The XML manifest + content-types the client ignores — include them to prove so.
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'))
  zip.addFile('extension.vsixmanifest', Buffer.from('<PackageManifest/>'))
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content))
  }
  return zip.toBuffer()
}

describe('extension-packaging vsix', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vsix-test-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function writeVsix(name: string, files: Record<string, string>): Promise<string> {
    const p = path.join(dir, name)
    await writeFile(p, buildVsix(files))
    return p
  }

  it('reads and validates extension/package.json', async () => {
    const vsix = await writeVsix('ok.vsix', {
      'extension/package.json': JSON.stringify(validManifest),
      'extension/dist/extension.js': 'module.exports={}',
    })
    const manifest = readVsixManifest(vsix)
    expect(manifest.name).toBe('sample')
    expect(manifest.publisher).toBe('acme')
    expect(manifest.version).toBe('1.2.3')
  })

  it('throws when package.json is missing', async () => {
    const vsix = await writeVsix('nopkg.vsix', { 'extension/dist/extension.js': 'x' })
    expect(() => readVsixManifest(vsix)).toThrow(/missing extension\/package\.json/)
  })

  it('throws when the manifest is invalid', async () => {
    const vsix = await writeVsix('bad.vsix', {
      'extension/package.json': JSON.stringify({ name: 'x' }), // no version/engines
    })
    expect(() => readVsixManifest(vsix)).toThrow(/invalid manifest/)
  })

  it('extracts only extension/** with the prefix stripped', async () => {
    const vsix = await writeVsix('extract.vsix', {
      'extension/package.json': JSON.stringify(validManifest),
      'extension/dist/extension.js': 'CODE',
      'extension/README.md': '# hi',
    })
    const target = path.join(dir, 'out')
    await mkdir(target, { recursive: true })
    await extractVsix(vsix, target)

    expect(await readFile(path.join(target, 'package.json'), 'utf8')).toContain('sample')
    expect(await readFile(path.join(target, 'dist', 'extension.js'), 'utf8')).toBe('CODE')
    expect(await readFile(path.join(target, 'README.md'), 'utf8')).toBe('# hi')
    // The XML/content-types files stay out of the installed tree.
    await expect(stat(path.join(target, 'extension.vsixmanifest'))).rejects.toThrow()
    await expect(stat(path.join(target, '[Content_Types].xml'))).rejects.toThrow()
  })

  it('rejects a zip-slip entry that escapes the target directory', async () => {
    const zip = new AdmZip()
    zip.addFile('extension/package.json', Buffer.from(JSON.stringify(validManifest)))
    // A crafted entry attempting to write outside the target via `../`. addFile
    // normalizes away `../`, so set the raw entryName directly to simulate a
    // hand-crafted malicious zip.
    zip.addFile('extension/placeholder.js', Buffer.from('PWNED'))
    const evil = zip.getEntries().find((e) => e.entryName.endsWith('placeholder.js'))!
    evil.entryName = 'extension/../../evil.js'
    const vsix = path.join(dir, 'evil.vsix')
    await writeFile(vsix, zip.toBuffer())

    const target = path.join(dir, 'out')
    await mkdir(target, { recursive: true })
    await expect(extractVsix(vsix, target)).rejects.toThrow(/escapes the target directory/)
  })

  describe('createVsix', () => {
    /** Lay out an extension directory on disk and return its path. */
    async function writeExtension(files: Record<string, string>): Promise<string> {
      const extDir = path.join(dir, 'ext')
      for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(extDir, rel)
        await mkdir(path.dirname(abs), { recursive: true })
        await writeFile(abs, content)
      }
      return extDir
    }

    it('round-trips: packs files[] payload and reads back the manifest', async () => {
      const extDir = await writeExtension({
        'package.json': JSON.stringify({ ...validManifest, files: ['dist', 'icon.png'] }),
        'dist/extension.js': 'CODE',
        'icon.png': 'PNG',
        'src/extension.ts': 'SOURCE', // not in files[] → must be excluded
      })
      const out = path.join(dir, 'out.vsix')
      await createVsix(extDir, out)

      expect(readVsixManifest(out).name).toBe('sample')
      const target = path.join(dir, 'unpacked')
      await mkdir(target, { recursive: true })
      await extractVsix(out, target)
      expect(await readFile(path.join(target, 'dist', 'extension.js'), 'utf8')).toBe('CODE')
      expect(await readFile(path.join(target, 'icon.png'), 'utf8')).toBe('PNG')
      await expect(stat(path.join(target, 'src', 'extension.ts'))).rejects.toThrow()
    })

    it('bundles README/CHANGELOG even when not listed in files[]', async () => {
      const extDir = await writeExtension({
        'package.json': JSON.stringify({ ...validManifest, files: ['dist'] }),
        'dist/extension.js': 'CODE',
        'README.md': '# readme',
        'CHANGELOG.md': '# changes',
      })
      const out = path.join(dir, 'docs.vsix')
      await createVsix(extDir, out)
      const target = path.join(dir, 'unpacked')
      await mkdir(target, { recursive: true })
      await extractVsix(out, target)
      expect(await readFile(path.join(target, 'README.md'), 'utf8')).toBe('# readme')
      expect(await readFile(path.join(target, 'CHANGELOG.md'), 'utf8')).toBe('# changes')
    })

    it('throws on a missing manifest', async () => {
      const extDir = await writeExtension({ 'dist/extension.js': 'CODE' })
      await expect(createVsix(extDir, path.join(dir, 'x.vsix'))).rejects.toThrow(/missing/)
    })

    it('throws on an invalid manifest', async () => {
      const extDir = await writeExtension({ 'package.json': JSON.stringify({ name: 'x' }) })
      await expect(createVsix(extDir, path.join(dir, 'x.vsix'))).rejects.toThrow(/invalid manifest/)
    })
  })
})
