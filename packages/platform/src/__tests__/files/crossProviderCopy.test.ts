/*---------------------------------------------------------------------------------------------
 *  Tests for the cross-provider copy/rename fallback
 *  (copyAcrossProviders in packages/platform/src/files/fileSystemProvider.ts).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { URI } from '../../base/uri.js'
import { FileSystemError, type IDirectoryEntry, type IFileStat } from '../../files/fileService.js'
import {
  FileService,
  copyAcrossProviders,
  type IFileSystemProvider,
} from '../../files/fileSystemProvider.js'

type MemNode =
  | { kind: 'file'; content: Uint8Array }
  | { kind: 'dir'; entries: Map<string, MemNode> }

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function cloneNode(node: MemNode): MemNode {
  return node.kind === 'file'
    ? { kind: 'file', content: node.content.slice() }
    : { kind: 'dir', entries: new Map([...node.entries].map(([k, v]) => [k, cloneNode(v)])) }
}

function segments(uri: URI): string[] {
  return uri.path.split('/').filter(Boolean)
}

/**
 * Map-backed in-memory provider with enough real semantics to exercise the
 * copy fallback without touching the real filesystem.
 */
class MemProvider implements IFileSystemProvider {
  readonly capabilities = { pathCaseSensitive: true, supportsTrash: true }
  private readonly root: Extract<MemNode, { kind: 'dir' }> = { kind: 'dir', entries: new Map() }
  /** When set, `delete` rejects — used for the rename-copy-succeeded scenario. */
  failDelete = false

  private node(uri: URI): MemNode | undefined {
    let current: MemNode | undefined = this.root
    for (const part of segments(uri)) {
      if (!current || current.kind !== 'dir') return undefined
      current = current.entries.get(part)
    }
    return current
  }

  private parent(uri: URI): { dir: Extract<MemNode, { kind: 'dir' }>; name: string } | undefined {
    const parts = segments(uri)
    const name = parts.pop()
    if (!name) return undefined
    let dir: Extract<MemNode, { kind: 'dir' }> = this.root
    for (const part of parts) {
      const next = dir.entries.get(part)
      if (!next || next.kind !== 'dir') return undefined
      dir = next
    }
    return { dir, name }
  }

  /** Test helper: seeds a file, creating parent directories as needed. */
  putFile(uri: URI, content: string | Uint8Array): void {
    const parts = segments(uri)
    const name = parts.pop()
    if (!name) throw new Error('cannot put a file at the root')
    let dir: Extract<MemNode, { kind: 'dir' }> = this.root
    for (const part of parts) {
      const next = dir.entries.get(part)
      if (!next || next.kind !== 'dir') {
        const created: MemNode = { kind: 'dir', entries: new Map() }
        dir.entries.set(part, created)
        dir = created
      } else {
        dir = next
      }
    }
    dir.entries.set(name, {
      kind: 'file',
      content: typeof content === 'string' ? text(content) : content,
    })
  }

  async readFile(resource: URI): Promise<Uint8Array> {
    const node = this.node(resource)
    if (!node || node.kind !== 'file') {
      throw new FileSystemError(`No such file: '${resource}'`, 'ENOENT')
    }
    return node.content
  }
  async readFileHead(resource: URI, maxBytes: number): Promise<Uint8Array> {
    return (await this.readFile(resource)).slice(0, maxBytes)
  }
  async readFileText(resource: URI): Promise<string> {
    return new TextDecoder().decode(await this.readFile(resource))
  }
  async writeFile(resource: URI, content: Uint8Array | string): Promise<void> {
    const located = this.parent(resource)
    if (!located) throw new FileSystemError(`No such parent: '${resource}'`, 'ENOENT')
    located.dir.entries.set(located.name, {
      kind: 'file',
      content: typeof content === 'string' ? text(content) : content,
    })
  }
  async exists(resource: URI): Promise<boolean> {
    return this.node(resource) !== undefined
  }
  async stat(resource: URI): Promise<IFileStat> {
    const node = this.node(resource)
    if (!node) throw new FileSystemError(`No such file: '${resource}'`, 'ENOENT')
    return {
      resource,
      isFile: node.kind === 'file',
      isDirectory: node.kind === 'dir',
      size: node.kind === 'file' ? node.content.byteLength : 0,
      mtime: 0,
    }
  }
  async list(resource: URI): Promise<IDirectoryEntry[]> {
    const node = this.node(resource)
    if (!node || node.kind !== 'dir') {
      throw new FileSystemError(`No such directory: '${resource}'`, 'ENOENT')
    }
    return [...node.entries].map(([name, entry]) => ({
      name,
      isFile: entry.kind === 'file',
      isDirectory: entry.kind === 'dir',
    }))
  }
  async createDirectory(resource: URI): Promise<void> {
    if (this.node(resource)) throw new FileSystemError(`Already exists: '${resource}'`, 'EEXIST')
    const located = this.parent(resource)
    if (!located) throw new FileSystemError(`No such parent: '${resource}'`, 'ENOENT')
    located.dir.entries.set(located.name, { kind: 'dir', entries: new Map() })
  }
  async delete(resource: URI, opts?: { recursive?: boolean; useTrash?: boolean }): Promise<void> {
    if (this.failDelete) throw new FileSystemError('delete failed', 'UNKNOWN')
    const node = this.node(resource)
    if (!node) throw new FileSystemError(`No such file: '${resource}'`, 'ENOENT')
    if (node.kind === 'dir' && node.entries.size > 0 && !opts?.recursive) {
      throw new FileSystemError(`Directory not empty: '${resource}'`, 'ENOTEMPTY')
    }
    const located = this.parent(resource)
    if (!located) throw new FileSystemError(`Cannot delete root: '${resource}'`, 'UNKNOWN')
    located.dir.entries.delete(located.name)
  }
  async rename(source: URI, target: URI): Promise<void> {
    const node = this.node(source)
    if (!node) throw new FileSystemError(`No such file: '${source}'`, 'ENOENT')
    const sourceLocated = this.parent(source)
    const targetLocated = this.parent(target)
    if (!sourceLocated || !targetLocated) throw new FileSystemError('Cannot move root', 'UNKNOWN')
    if (targetLocated.dir.entries.has(targetLocated.name)) {
      throw new FileSystemError(`Already exists: '${target}'`, 'EEXIST')
    }
    sourceLocated.dir.entries.delete(sourceLocated.name)
    targetLocated.dir.entries.set(targetLocated.name, node)
  }
  async copy(source: URI, target: URI): Promise<void> {
    const node = this.node(source)
    if (!node) throw new FileSystemError(`No such file: '${source}'`, 'ENOENT')
    const located = this.parent(target)
    if (!located) throw new FileSystemError(`No such parent: '${target}'`, 'ENOENT')
    located.dir.entries.set(located.name, cloneNode(node))
  }
  async listRecursive(root: URI): Promise<URI[]> {
    const out: URI[] = []
    const walk = (uri: URI): void => {
      const node = this.node(uri)
      if (!node || node.kind !== 'dir') return
      for (const [name, entry] of node.entries) {
        const child = URI.joinPath(uri, name)
        if (entry.kind === 'file') out.push(child)
        else walk(child)
      }
    }
    walk(root)
    return out
  }
}

function remote(path: string): URI {
  return URI.from({ scheme: 'remote-ssh', authority: 'host', path })
}

describe('copyAcrossProviders', () => {
  function setup(): { local: MemProvider; remoteProvider: MemProvider; svc: FileService } {
    const local = new MemProvider()
    const remoteProvider = new MemProvider()
    const svc = new FileService()
    svc.providers.register('file', local)
    svc.providers.register('remote-ssh', remoteProvider)
    return { local, remoteProvider, svc }
  }

  it('copies a single file across providers', async () => {
    const { local, remoteProvider } = setup()
    local.putFile(URI.file('/src/a.ts'), 'hello')
    await remoteProvider.createDirectory(remote('/dst'))

    await copyAcrossProviders(local, URI.file('/src/a.ts'), remoteProvider, remote('/dst/a.ts'))

    expect(await remoteProvider.readFileText(remote('/dst/a.ts'))).toBe('hello')
    expect(await local.readFileText(URI.file('/src/a.ts'))).toBe('hello')
  })

  it('recursively copies a directory tree with nested subdirectories', async () => {
    const { local, remoteProvider } = setup()
    local.putFile(URI.file('/proj/src/a.ts'), 'a')
    local.putFile(URI.file('/proj/src/nested/b.ts'), 'b')
    local.putFile(URI.file('/proj/README.md'), 'readme')

    await copyAcrossProviders(local, URI.file('/proj'), remoteProvider, remote('/proj'))

    expect(await remoteProvider.readFileText(remote('/proj/README.md'))).toBe('readme')
    expect(await remoteProvider.readFileText(remote('/proj/src/a.ts'))).toBe('a')
    expect(await remoteProvider.readFileText(remote('/proj/src/nested/b.ts'))).toBe('b')
    expect(await remoteProvider.list(remote('/proj/src'))).toHaveLength(2)
  })

  it('throws EEXIST when the target file exists and overwrite is false', async () => {
    const { local, remoteProvider } = setup()
    local.putFile(URI.file('/src/a.ts'), 'source')
    remoteProvider.putFile(remote('/dst/a.ts'), 'target')

    await expect(
      copyAcrossProviders(local, URI.file('/src/a.ts'), remoteProvider, remote('/dst/a.ts')),
    ).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await remoteProvider.readFileText(remote('/dst/a.ts'))).toBe('target')
  })

  it('throws EEXIST when the target directory exists and overwrite is false', async () => {
    const { local, remoteProvider } = setup()
    local.putFile(URI.file('/src/a.ts'), 'source')
    await remoteProvider.createDirectory(remote('/dst'))

    await expect(
      copyAcrossProviders(local, URI.file('/src'), remoteProvider, remote('/dst')),
    ).rejects.toMatchObject({ code: 'EEXIST' })
  })

  it('overwrites an existing target file with overwrite: true', async () => {
    const { local, remoteProvider } = setup()
    local.putFile(URI.file('/src/a.ts'), 'from-source')
    remoteProvider.putFile(remote('/dst/a.ts'), 'old-target')

    await copyAcrossProviders(local, URI.file('/src/a.ts'), remoteProvider, remote('/dst/a.ts'), {
      overwrite: true,
    })

    expect(await remoteProvider.readFileText(remote('/dst/a.ts'))).toBe('from-source')
  })

  it('merges directories with overwrite: true, keeping extra target entries', async () => {
    const { local, remoteProvider } = setup()
    local.putFile(URI.file('/src/same.ts'), 'from-source')
    local.putFile(URI.file('/src/only-src.ts'), 'src')
    remoteProvider.putFile(remote('/dst/same.ts'), 'old-target')
    remoteProvider.putFile(remote('/dst/only-dst.ts'), 'kept')

    await copyAcrossProviders(local, URI.file('/src'), remoteProvider, remote('/dst'), {
      overwrite: true,
    })

    expect(await remoteProvider.readFileText(remote('/dst/same.ts'))).toBe('from-source')
    expect(await remoteProvider.readFileText(remote('/dst/only-src.ts'))).toBe('src')
    expect(await remoteProvider.readFileText(remote('/dst/only-dst.ts'))).toBe('kept')
  })

  it('reports progress with correct byte totals (and only pre-walks when progress is given)', async () => {
    const { local, remoteProvider } = setup()
    local.putFile(URI.file('/proj/a.ts'), 'aaaa')
    local.putFile(URI.file('/proj/nested/b.ts'), 'bbbbbb')
    const statSpy = vi.spyOn(local, 'stat')

    const calls: Array<[number, number]> = []
    await copyAcrossProviders(local, URI.file('/proj'), remoteProvider, remote('/proj'), {
      progress: (transferred, totalBytes) => calls.push([transferred, totalBytes]),
    })

    expect(calls[0]).toEqual([0, 10])
    expect(calls.at(-1)).toEqual([10, 10])
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i]?.[0]).toBeGreaterThanOrEqual((calls[i - 1] as [number, number])[0])
    }
    // Root dispatch + one stat per entry (files and directories) in the pre-walk.
    expect(statSpy).toHaveBeenCalledTimes(4)
  })

  it('skips the totalBytes pre-walk when no progress callback is given', async () => {
    const { local, remoteProvider } = setup()
    local.putFile(URI.file('/proj/a.ts'), 'a')
    const statSpy = vi.spyOn(local, 'stat')

    await copyAcrossProviders(local, URI.file('/proj'), remoteProvider, remote('/proj'))

    expect(statSpy).toHaveBeenCalledTimes(1)
  })

  it('propagates a provider FileTooLarge error as-is', async () => {
    const { local, remoteProvider } = setup()
    local.putFile(URI.file('/src/a.ts'), 'x')
    vi.spyOn(local, 'readFile').mockRejectedValue(
      new FileSystemError('File is too large', 'FileTooLarge'),
    )

    await expect(
      copyAcrossProviders(local, URI.file('/src/a.ts'), remoteProvider, remote('/dst/a.ts')),
    ).rejects.toMatchObject({ code: 'FileTooLarge' })
  })

  it('throws ELOOP instead of recursing forever on a self-referential directory', async () => {
    const { local, remoteProvider } = setup()
    await local.createDirectory(URI.file('/loop'))
    // Stands in for a directory symlink pointing at an ancestor: every level is
    // a fresh URI, so a visited set would never catch it — only the depth cap does.
    vi.spyOn(local, 'list').mockResolvedValue([{ name: 'loop', isDirectory: true, isFile: false }])

    await expect(
      copyAcrossProviders(local, URI.file('/loop'), remoteProvider, remote('/loop')),
    ).rejects.toMatchObject({ code: 'ELOOP' })
  })

  it('caps the progress measurement walk at the same depth', async () => {
    const { local, remoteProvider } = setup()
    await local.createDirectory(URI.file('/loop'))
    vi.spyOn(local, 'list').mockResolvedValue([{ name: 'loop', isDirectory: true, isFile: false }])
    vi.spyOn(local, 'stat').mockResolvedValue({
      resource: URI.file('/loop'),
      isFile: false,
      isDirectory: true,
      isSymbolicLink: true,
      size: 0,
      mtime: 0,
    })

    await expect(
      copyAcrossProviders(local, URI.file('/loop'), remoteProvider, remote('/loop'), {
        progress: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'ELOOP' })
  })
})

describe('FileService cross-scheme rename', () => {
  function setup(): { local: MemProvider; remoteProvider: MemProvider; svc: FileService } {
    const local = new MemProvider()
    const remoteProvider = new MemProvider()
    const svc = new FileService()
    svc.providers.register('file', local)
    svc.providers.register('remote-ssh', remoteProvider)
    return { local, remoteProvider, svc }
  }

  it('cross-scheme rename copies and deletes the file source', async () => {
    const { local, remoteProvider, svc } = setup()
    local.putFile(URI.file('/src/a.ts'), 'hello')
    await remoteProvider.createDirectory(remote('/dst'))

    await svc.rename(URI.file('/src/a.ts'), remote('/dst/a.ts'))

    expect(await remoteProvider.readFileText(remote('/dst/a.ts'))).toBe('hello')
    expect(await local.exists(URI.file('/src/a.ts'))).toBe(false)
  })

  it('cross-scheme rename deletes a directory source recursively', async () => {
    const { local, remoteProvider, svc } = setup()
    local.putFile(URI.file('/proj/src/a.ts'), 'a')

    await svc.rename(URI.file('/proj'), remote('/proj'))

    expect(await remoteProvider.readFileText(remote('/proj/src/a.ts'))).toBe('a')
    expect(await local.exists(URI.file('/proj'))).toBe(false)
  })

  it('keeps the copied target and throws when deleting the source fails', async () => {
    const { local, remoteProvider, svc } = setup()
    local.putFile(URI.file('/src/a.ts'), 'hello')
    await remoteProvider.createDirectory(remote('/dst'))
    local.failDelete = true

    await expect(svc.rename(URI.file('/src/a.ts'), remote('/dst/a.ts'))).rejects.toThrow(
      /deleting the source failed/,
    )
    expect(await remoteProvider.readFileText(remote('/dst/a.ts'))).toBe('hello')
    expect(await local.exists(URI.file('/src/a.ts'))).toBe(true)
  })
})

describe('FileService cross-scheme copy failures', () => {
  it('says the target may be partially written and keeps the underlying code', async () => {
    const local = new MemProvider()
    const remoteProvider = new MemProvider()
    const svc = new FileService()
    svc.providers.register('file', local)
    svc.providers.register('remote-ssh', remoteProvider)
    local.putFile(URI.file('/proj/a.ts'), 'a')
    local.putFile(URI.file('/proj/b.ts'), 'b')
    vi.spyOn(local, 'readFile').mockRejectedValueOnce(
      new FileSystemError('read failed', 'FileTooLarge'),
    )

    await expect(svc.copy(URI.file('/proj'), remote('/proj'))).rejects.toMatchObject({
      code: 'FileTooLarge',
      message: expect.stringMatching(/may be partially written/),
    })
  })
})

describe('FileService same-scheme delegation', () => {
  it('same-scheme copy delegates to provider.copy without read/write fallback', async () => {
    const local = new MemProvider()
    const svc = new FileService()
    svc.providers.register('file', local)
    local.putFile(URI.file('/a.ts'), 'x')
    const copySpy = vi.spyOn(local, 'copy')
    const readSpy = vi.spyOn(local, 'readFile')
    const writeSpy = vi.spyOn(local, 'writeFile')

    await svc.copy(URI.file('/a.ts'), URI.file('/b.ts'))

    expect(copySpy).toHaveBeenCalledTimes(1)
    expect(readSpy).not.toHaveBeenCalled()
    expect(writeSpy).not.toHaveBeenCalled()
    expect(await local.readFileText(URI.file('/b.ts'))).toBe('x')
  })

  it('same-scheme rename delegates to provider.rename without copy fallback', async () => {
    const local = new MemProvider()
    const svc = new FileService()
    svc.providers.register('file', local)
    local.putFile(URI.file('/a.ts'), 'x')
    const renameSpy = vi.spyOn(local, 'rename')
    const readSpy = vi.spyOn(local, 'readFile')
    const writeSpy = vi.spyOn(local, 'writeFile')

    await svc.rename(URI.file('/a.ts'), URI.file('/b.ts'))

    expect(renameSpy).toHaveBeenCalledTimes(1)
    expect(readSpy).not.toHaveBeenCalled()
    expect(writeSpy).not.toHaveBeenCalled()
    expect(await local.exists(URI.file('/a.ts'))).toBe(false)
  })
})
