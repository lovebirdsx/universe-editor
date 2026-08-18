/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/files/fileSystemProvider.ts.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { URI } from '../../base/uri.js'
import { FileSystemError, type IDirectoryEntry, type IFileStat } from '../../files/fileService.js'
import {
  FileService,
  FileSystemProviderRegistry,
  type IFileSystemProvider,
} from '../../files/fileSystemProvider.js'

/** Records the URIs it received so dispatch can be asserted without real IO. */
class RecordingProvider implements IFileSystemProvider {
  readonly capabilities = { pathCaseSensitive: true }
  readonly seen: URI[] = []

  realpath?: (resource: URI) => Promise<URI>
  listDrives?: () => Promise<string[]>

  constructor(withOptionals = true) {
    // Assigned in the body, not as field initializers: a filesystem without
    // symlink or drive semantics simply omits these members.
    if (withOptionals) {
      this.realpath = async (resource) => resource
      this.listDrives = async () => ['C:']
    }
  }

  async readFile(resource: URI): Promise<Uint8Array> {
    this.seen.push(resource)
    return new Uint8Array()
  }
  async readFileHead(resource: URI): Promise<Uint8Array> {
    this.seen.push(resource)
    return new Uint8Array()
  }
  async readFileText(resource: URI): Promise<string> {
    this.seen.push(resource)
    return resource.toString()
  }
  async writeFile(resource: URI): Promise<void> {
    this.seen.push(resource)
  }
  async exists(resource: URI): Promise<boolean> {
    this.seen.push(resource)
    return true
  }
  async stat(resource: URI): Promise<IFileStat> {
    this.seen.push(resource)
    return {
      resource,
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      size: 0,
      mtime: 0,
    }
  }
  async list(resource: URI): Promise<IDirectoryEntry[]> {
    this.seen.push(resource)
    return []
  }
  async createDirectory(resource: URI): Promise<void> {
    this.seen.push(resource)
  }
  async delete(resource: URI): Promise<void> {
    this.seen.push(resource)
  }
  async rename(source: URI, target: URI): Promise<void> {
    this.seen.push(source, target)
  }
  async copy(source: URI, target: URI): Promise<void> {
    this.seen.push(source, target)
  }
  async listRecursive(root: URI): Promise<URI[]> {
    this.seen.push(root)
    return [URI.from({ scheme: root.scheme, authority: root.authority, path: '/a.ts' })]
  }
}

function remote(path: string): URI {
  return URI.from({ scheme: 'remote-ssh', authority: 'host', path })
}

describe('FileSystemProviderRegistry', () => {
  it('registers, looks up and lists schemes', () => {
    const registry = new FileSystemProviderRegistry()
    const provider = new RecordingProvider()
    registry.register('file', provider)

    expect(registry.get('file')).toBe(provider)
    expect(registry.has('file')).toBe(true)
    expect(registry.has('remote-ssh')).toBe(false)
    expect(registry.schemes()).toEqual(['file'])
  })

  it('rejects a duplicate scheme instead of silently replacing the provider', () => {
    const registry = new FileSystemProviderRegistry()
    registry.register('file', new RecordingProvider())
    expect(() => registry.register('file', new RecordingProvider())).toThrow(/already registered/)
  })

  it('disposing unregisters, and a stale disposable never evicts a newer provider', () => {
    const registry = new FileSystemProviderRegistry()
    const first = new RecordingProvider()
    const handle = registry.register('file', first)

    handle.dispose()
    expect(registry.has('file')).toBe(false)

    const second = new RecordingProvider()
    registry.register('file', second)
    handle.dispose()
    expect(registry.get('file')).toBe(second)
  })
})

describe('FileService scheme dispatch', () => {
  function setup(): {
    svc: FileService
    local: RecordingProvider
    remoteProvider: RecordingProvider
  } {
    const svc = new FileService()
    const local = new RecordingProvider()
    const remoteProvider = new RecordingProvider()
    svc.providers.register('file', local)
    svc.providers.register('remote-ssh', remoteProvider)
    return { svc, local, remoteProvider }
  }

  it('routes each call to the provider registered for the resource scheme', async () => {
    const { svc, local, remoteProvider } = setup()

    await svc.readFileText(URI.file('/a.ts'))
    await svc.readFileText(remote('/b.ts'))

    expect(local.seen.map((u) => u.toString())).toEqual(['file:///a.ts'])
    expect(remoteProvider.seen.map((u) => u.toString())).toEqual(['remote-ssh://host/b.ts'])
  })

  it('rejects an unregistered scheme rather than falling back to the local provider', async () => {
    const { svc, local } = setup()
    await expect(svc.readFileText(URI.parse('untitled:/draft'))).rejects.toThrow(
      /Unsupported scheme: untitled/,
    )
    expect(local.seen).toHaveLength(0)
  })

  it('surfaces the unsupported-scheme failure as a rejection, not a synchronous throw', () => {
    const { svc } = setup()
    // A synchronous throw would bypass every `.catch()` in the codebase.
    expect(() => void svc.exists(URI.parse('untitled:/draft')).catch(() => undefined)).not.toThrow()
  })

  it('revives wire-shaped inputs (components and strings) before dispatching', async () => {
    const { svc, remoteProvider } = setup()

    await svc.exists({ scheme: 'remote-ssh', authority: 'host', path: '/c.ts' } as never)
    await svc.exists('remote-ssh://host/d.ts' as never)

    expect(remoteProvider.seen.map((u) => u.toString())).toEqual([
      'remote-ssh://host/c.ts',
      'remote-ssh://host/d.ts',
    ])
  })

  it('returns URIs from listRecursive that keep the root scheme and authority', async () => {
    const { svc } = setup()
    const files = await svc.listRecursive(remote('/proj'))
    expect(files.map((u) => u.toString())).toEqual(['remote-ssh://host/a.ts'])
  })

  it('rejects cross-scheme rename and copy', async () => {
    const { svc, local, remoteProvider } = setup()

    await expect(svc.rename(URI.file('/a.ts'), remote('/a.ts'))).rejects.toThrow(
      /Cross-scheme rename/,
    )
    await expect(svc.copy(URI.file('/a.ts'), remote('/a.ts'))).rejects.toThrow(/Cross-scheme copy/)
    expect(local.seen).toHaveLength(0)
    expect(remoteProvider.seen).toHaveLength(0)
  })

  it('allows same-scheme rename and copy', async () => {
    const { svc, remoteProvider } = setup()
    await svc.rename(remote('/a.ts'), remote('/b.ts'))
    expect(remoteProvider.seen.map((u) => u.toString())).toEqual([
      'remote-ssh://host/a.ts',
      'remote-ssh://host/b.ts',
    ])
  })

  it('routes listDrives to the file: provider regardless of the active workspace', async () => {
    const { svc, remoteProvider } = setup()
    const drives = await svc.listDrives()
    expect(drives).toEqual(['C:'])
    expect(remoteProvider.seen).toHaveLength(0)
  })

  it('listDrives returns empty when the local provider does not implement it', async () => {
    const svc = new FileService()
    svc.providers.register('file', new RecordingProvider(false))
    expect(await svc.listDrives()).toEqual([])
  })

  it('rejects realpath for a provider without symlink semantics', async () => {
    const svc = new FileService()
    svc.providers.register('remote-ssh', new RecordingProvider(false))
    await expect(svc.realpath(remote('/a.ts'))).rejects.toThrow(
      /realpath is not supported for scheme: remote-ssh/,
    )
  })

  it('propagates a provider FileSystemError with its code intact', async () => {
    const svc = new FileService()
    const provider = new RecordingProvider()
    vi.spyOn(provider, 'readFileText').mockRejectedValue(new FileSystemError('gone', 'ENOENT'))
    svc.providers.register('file', provider)

    await expect(svc.readFileText(URI.file('/a.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('accepts an externally owned registry so a host can share one across services', async () => {
    const registry = new FileSystemProviderRegistry()
    const provider = new RecordingProvider()
    const svc = new FileService(registry)

    registry.register('file', provider)
    await svc.exists(URI.file('/a.ts'))
    expect(provider.seen).toHaveLength(1)
  })
})
