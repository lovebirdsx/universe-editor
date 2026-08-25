/*---------------------------------------------------------------------------------------------
 *  Tests for the file: provider's read-size backstop — a single oversized
 *  fs.readFile/readFileText allocation can OOM the process, so reads are
 *  rejected with FileTooLarge before the buffer is ever allocated.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSystemError, URI } from '@universe-editor/platform'
import { NodeFileSystemProvider } from '../nodeFileSystemProvider.js'

describe('NodeFileSystemProvider read-size backstop', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'universe-editor-nfsp-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('reads a file under the text cap', async () => {
    const file = join(dir, 'small.txt')
    await fs.writeFile(file, 'hello', 'utf8')
    const provider = new NodeFileSystemProvider({ maxTextBytes: 16 })
    await expect(provider.readFileText(URI.file(file))).resolves.toBe('hello')
  })

  it('throws FileTooLarge when readFileText exceeds the cap', async () => {
    const file = join(dir, 'big.txt')
    await fs.writeFile(file, 'x'.repeat(32), 'utf8')
    const provider = new NodeFileSystemProvider({ maxTextBytes: 16 })
    await expect(provider.readFileText(URI.file(file))).rejects.toMatchObject({
      name: 'FileSystemError',
      code: 'FileTooLarge',
    })
  })

  it('throws FileTooLarge when readFile exceeds the cap', async () => {
    const file = join(dir, 'big.bin')
    await fs.writeFile(file, Buffer.alloc(32))
    const provider = new NodeFileSystemProvider({ maxBinaryBytes: 16 })
    await expect(provider.readFile(URI.file(file))).rejects.toMatchObject({
      name: 'FileSystemError',
      code: 'FileTooLarge',
    })
  })

  it('message carries the actual size and the limit', async () => {
    const file = join(dir, 'big.txt')
    await fs.writeFile(file, 'x'.repeat(2 * 1024 * 1024), 'utf8')
    const provider = new NodeFileSystemProvider({ maxTextBytes: 1024 * 1024 })
    const err = (await provider.readFileText(URI.file(file)).catch((e) => e)) as FileSystemError
    expect(err).toBeInstanceOf(FileSystemError)
    expect(err.code).toBe('FileTooLarge')
    expect(err.message).toMatch(/2\.0MB/)
    expect(err.message).toMatch(/1MB/)
  })
})

describe('NodeFileSystemProvider readFileHead', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'universe-editor-nfsp-head-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('reads only the first maxBytes of a larger file', async () => {
    const file = join(dir, 'head.bin')
    await fs.writeFile(file, Buffer.from([1, 2, 3, 4, 5]))
    const provider = new NodeFileSystemProvider()
    const head = await provider.readFileHead(URI.file(file), 3)
    expect([...head]).toEqual([1, 2, 3])
  })

  it('reads the whole file when it is smaller than maxBytes', async () => {
    const file = join(dir, 'small.bin')
    await fs.writeFile(file, Buffer.from([1, 2]))
    const provider = new NodeFileSystemProvider()
    const head = await provider.readFileHead(URI.file(file), 16)
    expect([...head]).toEqual([1, 2])
  })

  it('maps a missing file to FileSystemError ENOENT', async () => {
    const provider = new NodeFileSystemProvider()
    await expect(
      provider.readFileHead(URI.file(join(dir, 'missing.bin')), 16),
    ).rejects.toMatchObject({
      name: 'FileSystemError',
      code: 'ENOENT',
    })
  })
})

describe('NodeFileSystemProvider trash capability', () => {
  it('reports supportsTrash only when a trash hook was injected', () => {
    // The hook is how a host lends its shell trash API (Electron's
    // shell.trashItem). Without one there is nowhere for a deleted file to go,
    // so callers must be told before they promise the user a recycle bin.
    expect(new NodeFileSystemProvider().capabilities.supportsTrash).toBe(false)
    expect(
      new NodeFileSystemProvider({ trash: async () => undefined }).capabilities.supportsTrash,
    ).toBe(true)
  })

  it('rejects useTrash without a hook instead of deleting permanently', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'universe-editor-nfsp-trash-'))
    const file = join(dir, 'keep.txt')
    await fs.writeFile(file, 'data', 'utf8')
    try {
      const provider = new NodeFileSystemProvider()
      await expect(provider.delete(URI.file(file), { useTrash: true })).rejects.toBeInstanceOf(
        FileSystemError,
      )
      // The file survives: a failed trash must never fall through to unlink.
      await expect(fs.readFile(file, 'utf8')).resolves.toBe('data')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
