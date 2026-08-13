/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IFileSystemProvider (platform/files).
 *
 *  Scheme-routed filesystem: `FileService` implements `IFileService` by
 *  dispatching each call to the `IFileSystemProvider` registered for the
 *  resource's URI scheme. The local `file:` provider lives on the main side;
 *  future providers (e.g. a remote host reached over a tunnelled channel) plug
 *  into the same registry without touching consumers.
 *--------------------------------------------------------------------------------------------*/

import { URI, type UriComponents } from '../base/uri.js'
import { Disposable, toDisposable, type IDisposable } from '../base/lifecycle.js'
import {
  FileSystemError,
  type IDirectoryEntry,
  type IFileService,
  type IFileStat,
} from './fileService.js'

export interface IFileSystemProviderCapabilities {
  /**
   * Whether paths on this filesystem compare case-sensitively (true on Linux
   * hosts, false on Windows/macOS). Feed this into
   * `IUriIdentityService.registerSchemeCaseSensitivity` when the provider's
   * scheme differs from the local platform's policy.
   */
  readonly pathCaseSensitive: boolean
}

/**
 * A filesystem backing one URI scheme. Mirrors `IFileService` but always
 * receives revived `URI` instances of its own scheme — the dispatching
 * `FileService` handles wire revival and scheme routing.
 */
export interface IFileSystemProvider {
  readonly capabilities: IFileSystemProviderCapabilities

  readFile(resource: URI): Promise<Uint8Array>
  readFileText(resource: URI, encoding?: 'utf8'): Promise<string>
  writeFile(resource: URI, content: Uint8Array | string): Promise<void>

  exists(resource: URI): Promise<boolean>
  stat(resource: URI): Promise<IFileStat>
  list(resource: URI): Promise<IDirectoryEntry[]>

  /** See `IFileService.realpath`. Omit when the filesystem has no symlink semantics. */
  realpath?(resource: URI): Promise<URI>
  /** See `IFileService.listDrives`. Only meaningful for the local Windows filesystem. */
  listDrives?(): Promise<string[]>

  createDirectory(resource: URI): Promise<void>
  delete(resource: URI, opts?: { recursive?: boolean; useTrash?: boolean }): Promise<void>
  rename(source: URI, target: URI, opts?: { overwrite?: boolean }): Promise<void>
  copy(source: URI, target: URI, opts?: { overwrite?: boolean }): Promise<void>
  listRecursive(
    root: URI,
    options?: { ignore?: readonly string[]; maxFiles?: number; maxDepth?: number },
  ): Promise<URI[]>
}

export class FileSystemProviderRegistry {
  private readonly _providers = new Map<string, IFileSystemProvider>()

  register(scheme: string, provider: IFileSystemProvider): IDisposable {
    if (this._providers.has(scheme)) {
      throw new Error(`A filesystem provider for scheme '${scheme}' is already registered`)
    }
    this._providers.set(scheme, provider)
    return toDisposable(() => {
      if (this._providers.get(scheme) === provider) this._providers.delete(scheme)
    })
  }

  get(scheme: string): IFileSystemProvider | undefined {
    return this._providers.get(scheme)
  }

  has(scheme: string): boolean {
    return this._providers.has(scheme)
  }

  schemes(): string[] {
    return [...this._providers.keys()]
  }
}

type RawUri = URI | UriComponents | string

/** Over ProxyChannel the reviver hands back real URIs, but direct callers (and
 *  tests simulating the wire) may still pass components or strings. */
function reviveUri(value: RawUri): URI {
  if (value instanceof URI) return value
  if (typeof value === 'string') return URI.parse(value)
  return URI.revive(value) as URI
}

/**
 * `IFileService` implementation that routes each call to the provider
 * registered for the resource's scheme. Cross-scheme rename/copy is rejected —
 * moving data between filesystems is a higher-level (read + write) concern.
 */
export class FileService extends Disposable implements IFileService {
  declare readonly _serviceBrand: undefined

  readonly providers: FileSystemProviderRegistry

  constructor(providers?: FileSystemProviderRegistry) {
    super()
    this.providers = providers ?? new FileSystemProviderRegistry()
  }

  private _resolve(resource: RawUri): { provider: IFileSystemProvider; uri: URI } {
    const uri = reviveUri(resource)
    const provider = this.providers.get(uri.scheme)
    if (!provider) {
      throw new FileSystemError(`Unsupported scheme: ${uri.scheme}`, 'UNKNOWN')
    }
    return { provider, uri }
  }

  async readFile(resource: URI): Promise<Uint8Array> {
    const { provider, uri } = this._resolve(resource)
    return provider.readFile(uri)
  }

  async readFileText(resource: URI, encoding?: 'utf8'): Promise<string> {
    const { provider, uri } = this._resolve(resource)
    return provider.readFileText(uri, encoding)
  }

  async writeFile(resource: URI, content: Uint8Array | string): Promise<void> {
    const { provider, uri } = this._resolve(resource)
    return provider.writeFile(uri, content)
  }

  async exists(resource: URI): Promise<boolean> {
    const { provider, uri } = this._resolve(resource)
    return provider.exists(uri)
  }

  async stat(resource: URI): Promise<IFileStat> {
    const { provider, uri } = this._resolve(resource)
    return provider.stat(uri)
  }

  async list(resource: URI): Promise<IDirectoryEntry[]> {
    const { provider, uri } = this._resolve(resource)
    return provider.list(uri)
  }

  async realpath(resource: URI): Promise<URI> {
    const { provider, uri } = this._resolve(resource)
    if (!provider.realpath) {
      throw new FileSystemError(`realpath is not supported for scheme: ${uri.scheme}`, 'UNKNOWN')
    }
    return provider.realpath(uri)
  }

  /** Drive roots are a local-Windows notion; routed to the `file:` provider. */
  async listDrives(): Promise<string[]> {
    const local = this.providers.get('file')
    if (!local?.listDrives) return []
    return local.listDrives()
  }

  async createDirectory(resource: URI): Promise<void> {
    const { provider, uri } = this._resolve(resource)
    return provider.createDirectory(uri)
  }

  async delete(resource: URI, opts?: { recursive?: boolean; useTrash?: boolean }): Promise<void> {
    const { provider, uri } = this._resolve(resource)
    return provider.delete(uri, opts)
  }

  async rename(source: URI, target: URI, opts?: { overwrite?: boolean }): Promise<void> {
    const { provider, uri } = this._resolve(source)
    const dst = reviveUri(target)
    if (dst.scheme !== uri.scheme) {
      throw new FileSystemError(
        `Cross-scheme rename is not supported: ${uri.scheme} -> ${dst.scheme}`,
        'UNKNOWN',
      )
    }
    return provider.rename(uri, dst, opts)
  }

  async copy(source: URI, target: URI, opts?: { overwrite?: boolean }): Promise<void> {
    const { provider, uri } = this._resolve(source)
    const dst = reviveUri(target)
    if (dst.scheme !== uri.scheme) {
      throw new FileSystemError(
        `Cross-scheme copy is not supported: ${uri.scheme} -> ${dst.scheme}`,
        'UNKNOWN',
      )
    }
    return provider.copy(uri, dst, opts)
  }

  async listRecursive(
    root: URI,
    options?: { ignore?: readonly string[]; maxFiles?: number; maxDepth?: number },
  ): Promise<URI[]> {
    const { provider, uri } = this._resolve(root)
    return provider.listRecursive(uri, options)
  }
}
