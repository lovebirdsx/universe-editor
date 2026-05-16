/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/files/fileSystemMainService.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSystemError, URI } from '@universe-editor/platform'
import { FileSystemMainService } from '../fileSystemMainService.js'

describe('FileSystemMainService', () => {
  let root: string
  const service = new FileSystemMainService()

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'universe-editor-fs-'))
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('writes and reads file bytes round-trip', async () => {
    const target = URI.file(join(root, 'hello.bin'))
    const payload = new Uint8Array([1, 2, 3, 4])
    await service.writeFile(target, payload)
    const back = await service.readFile(target)
    expect(Array.from(back)).toEqual([1, 2, 3, 4])
  })

  it('writeFile + readFileText handles utf8 strings', async () => {
    const target = URI.file(join(root, 'hello.txt'))
    await service.writeFile(target, 'héllo')
    await expect(service.readFileText(target)).resolves.toBe('héllo')
  })

  it('stat distinguishes file from directory', async () => {
    const fileUri = URI.file(join(root, 'a.txt'))
    await service.writeFile(fileUri, 'x')
    const fileStat = await service.stat(fileUri)
    expect(fileStat.isFile).toBe(true)
    expect(fileStat.isDirectory).toBe(false)

    const dirUri = URI.file(root)
    const dirStat = await service.stat(dirUri)
    expect(dirStat.isFile).toBe(false)
    expect(dirStat.isDirectory).toBe(true)
  })

  it('list returns entries with type flags', async () => {
    await service.writeFile(URI.file(join(root, 'a.txt')), 'x')
    await service.createDirectory(URI.file(join(root, 'sub')))
    const entries = await service.list(URI.file(root))
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'a.txt', isFile: true, isDirectory: false }),
        expect.objectContaining({ name: 'sub', isFile: false, isDirectory: true }),
      ]),
    )
  })

  it('exists is true for files and false for missing paths', async () => {
    const present = URI.file(join(root, 'present.txt'))
    await service.writeFile(present, 'x')
    await expect(service.exists(present)).resolves.toBe(true)
    await expect(service.exists(URI.file(join(root, 'missing.txt')))).resolves.toBe(false)
  })

  it('createDirectory creates nested dirs', async () => {
    const deep = URI.file(join(root, 'a', 'b', 'c'))
    await service.createDirectory(deep)
    await expect(service.exists(deep)).resolves.toBe(true)
  })

  it('readFile on missing path throws FileSystemError with code ENOENT', async () => {
    const missing = URI.file(join(root, 'does-not-exist.txt'))
    await expect(service.readFile(missing)).rejects.toMatchObject({
      name: 'FileSystemError',
      code: 'ENOENT',
    })
  })

  it('rejects non-file scheme URIs', async () => {
    const bad = URI.parse('http://example.com/x')
    await expect(service.readFile(bad)).rejects.toBeInstanceOf(FileSystemError)
  })

  it('accepts UriComponents-shaped input (revives over the wire)', async () => {
    const target = URI.file(join(root, 'wire.txt'))
    await service.writeFile(target, 'ok')
    const components = target.toJSON()
    // simulate how ProxyChannel would deliver the args after JSON round-trip
    await expect(service.readFileText(components as unknown as URI)).resolves.toBe('ok')
  })
})
