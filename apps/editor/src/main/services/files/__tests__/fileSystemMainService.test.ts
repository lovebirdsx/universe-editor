/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/files/fileSystemMainService.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { FileSystemError, URI } from '@universe-editor/platform'
import { FileSystemMainService } from '../fileSystemMainService.js'

const trashItem = vi.fn(async (_p: string) => {})
vi.mock('electron', () => ({ shell: { trashItem: (p: string) => trashItem(p) } }))

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

  // -------- delete --------

  it('delete removes a file', async () => {
    const target = URI.file(join(root, 'gone.txt'))
    await service.writeFile(target, 'x')
    await service.delete(target)
    await expect(service.exists(target)).resolves.toBe(false)
  })

  it('delete removes an empty directory', async () => {
    const dir = URI.file(join(root, 'empty'))
    await service.createDirectory(dir)
    await service.delete(dir)
    await expect(service.exists(dir)).resolves.toBe(false)
  })

  it('delete with recursive=true removes a non-empty directory', async () => {
    const dir = URI.file(join(root, 'tree'))
    await service.createDirectory(dir)
    await service.writeFile(URI.file(join(root, 'tree', 'a.txt')), 'a')
    await service.delete(dir, { recursive: true })
    await expect(service.exists(dir)).resolves.toBe(false)
  })

  it('delete without recursive on a non-empty directory throws ENOTEMPTY', async () => {
    const dir = URI.file(join(root, 'tree2'))
    await service.createDirectory(dir)
    await service.writeFile(URI.file(join(root, 'tree2', 'a.txt')), 'a')
    await expect(service.delete(dir)).rejects.toMatchObject({
      name: 'FileSystemError',
      code: 'ENOTEMPTY',
    })
  })

  it('delete on missing path throws ENOENT', async () => {
    const missing = URI.file(join(root, 'nope.txt'))
    await expect(service.delete(missing)).rejects.toMatchObject({
      name: 'FileSystemError',
      code: 'ENOENT',
    })
  })

  it('delete with useTrash routes to shell.trashItem with an OS-normalized path', async () => {
    trashItem.mockClear()
    const target = URI.file(join(root, 'trashed.txt'))
    await service.writeFile(target, 'x')
    await service.delete(target, { useTrash: true })
    expect(trashItem).toHaveBeenCalledTimes(1)
    // shell.trashItem needs the platform separator, not the forward-slash fsPath.
    expect(trashItem).toHaveBeenCalledWith(normalize(target.fsPath))
    // The real file is untouched by our mock (mock does not actually trash).
    await expect(service.exists(target)).resolves.toBe(true)
  })

  it('delete with useTrash wraps trash failures in FileSystemError', async () => {
    trashItem.mockClear()
    trashItem.mockRejectedValueOnce(new Error('boom'))
    const target = URI.file(join(root, 'trash-fail.txt'))
    await service.writeFile(target, 'x')
    await expect(service.delete(target, { useTrash: true })).rejects.toBeInstanceOf(FileSystemError)
  })

  // -------- rename --------

  it('rename moves a file', async () => {
    const src = URI.file(join(root, 'a.txt'))
    const dst = URI.file(join(root, 'b.txt'))
    await service.writeFile(src, 'hi')
    await service.rename(src, dst)
    await expect(service.exists(src)).resolves.toBe(false)
    await expect(service.readFileText(dst)).resolves.toBe('hi')
  })

  it('rename to an existing target without overwrite throws EEXIST', async () => {
    const src = URI.file(join(root, 'a.txt'))
    const dst = URI.file(join(root, 'b.txt'))
    await service.writeFile(src, 'hi')
    await service.writeFile(dst, 'taken')
    await expect(service.rename(src, dst)).rejects.toMatchObject({
      name: 'FileSystemError',
      code: 'EEXIST',
    })
  })

  it('rename of a missing source throws ENOENT', async () => {
    const src = URI.file(join(root, 'missing.txt'))
    const dst = URI.file(join(root, 'b.txt'))
    await expect(service.rename(src, dst)).rejects.toMatchObject({
      name: 'FileSystemError',
      code: 'ENOENT',
    })
  })

  // -------- copy --------

  it('copy duplicates a file, leaving the source in place', async () => {
    const src = URI.file(join(root, 'a.txt'))
    const dst = URI.file(join(root, 'b.txt'))
    await service.writeFile(src, 'hi')
    await service.copy(src, dst)
    await expect(service.readFileText(src)).resolves.toBe('hi')
    await expect(service.readFileText(dst)).resolves.toBe('hi')
  })

  it('copy recursively duplicates a directory tree', async () => {
    await service.createDirectory(URI.file(join(root, 'src', 'nested')))
    await service.writeFile(URI.file(join(root, 'src', 'nested', 'a.txt')), 'a')
    await service.copy(URI.file(join(root, 'src')), URI.file(join(root, 'dst')))
    await expect(
      service.readFileText(URI.file(join(root, 'dst', 'nested', 'a.txt'))),
    ).resolves.toBe('a')
  })

  it('copy to an existing target without overwrite throws EEXIST', async () => {
    const src = URI.file(join(root, 'a.txt'))
    const dst = URI.file(join(root, 'b.txt'))
    await service.writeFile(src, 'hi')
    await service.writeFile(dst, 'taken')
    await expect(service.copy(src, dst)).rejects.toMatchObject({
      name: 'FileSystemError',
      code: 'EEXIST',
    })
  })

  it('copy with overwrite replaces an existing target', async () => {
    const src = URI.file(join(root, 'a.txt'))
    const dst = URI.file(join(root, 'b.txt'))
    await service.writeFile(src, 'fresh')
    await service.writeFile(dst, 'stale')
    await service.copy(src, dst, { overwrite: true })
    await expect(service.readFileText(dst)).resolves.toBe('fresh')
  })

  it('copy of a missing source throws ENOENT', async () => {
    const src = URI.file(join(root, 'missing.txt'))
    const dst = URI.file(join(root, 'b.txt'))
    await expect(service.copy(src, dst)).rejects.toMatchObject({
      name: 'FileSystemError',
      code: 'ENOENT',
    })
  })

  // -------- realpath --------

  it('realpath returns an existing path canonicalized', async () => {
    const target = URI.file(join(root, 'plain.txt'))
    await service.writeFile(target, 'x')
    const real = await service.realpath(target)
    // On macOS tmpdir is itself a symlink (/var -> /private/var); compare against
    // the OS realpath of the same input rather than the literal path. Normalize
    // separators through URI.file (Windows fsPath uses forward slashes).
    const expected = URI.file(await fs.realpath(join(root, 'plain.txt'))).fsPath
    expect(real.fsPath).toBe(expected)
  })

  it('realpath resolves a symlink to its real target', async () => {
    const realFile = join(root, 'real.txt')
    await service.writeFile(URI.file(realFile), 'x')
    const link = join(root, 'link.txt')
    try {
      await fs.symlink(realFile, link)
    } catch {
      return // symlink creation not permitted (e.g. Windows without privilege)
    }
    const resolved = await service.realpath(URI.file(link))
    expect(resolved.fsPath).toBe(URI.file(await fs.realpath(realFile)).fsPath)
  })

  it('realpath of a not-yet-existing path resolves the existing prefix', async () => {
    // parent exists, the file does not — realpath should canonicalize the parent
    // and re-append the missing tail rather than throwing ENOENT.
    const missing = URI.file(join(root, 'new-file.txt'))
    const resolved = await service.realpath(missing)
    expect(resolved.fsPath).toBe(URI.file(join(await fs.realpath(root), 'new-file.txt')).fsPath)
  })

  it('realpath follows a symlinked parent directory for a missing child', async () => {
    const realDir = join(root, 'realdir')
    await service.createDirectory(URI.file(realDir))
    const linkDir = join(root, 'linkdir')
    try {
      await fs.symlink(realDir, linkDir, 'dir')
    } catch {
      return // symlink/junction creation not permitted
    }
    const resolved = await service.realpath(URI.file(join(linkDir, 'child.txt')))
    expect(resolved.fsPath).toBe(URI.file(join(await fs.realpath(realDir), 'child.txt')).fsPath)
  })
})
