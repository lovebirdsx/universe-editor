import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import AdmZip from 'adm-zip'
import { readVsixManifest, extractVsix } from '../vsix.js'

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
})
