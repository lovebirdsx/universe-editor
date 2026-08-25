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
  readFileHead(resource: URI, maxBytes: number): Promise<Uint8Array>
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
 * registered for the resource's scheme. Cross-scheme rename/copy falls back to
 * `copyAcrossProviders` — a read + write transfer through both providers.
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

  async readFileHead(resource: URI, maxBytes: number): Promise<Uint8Array> {
    const { provider, uri } = this._resolve(resource)
    return provider.readFileHead(uri, maxBytes)
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

  /**
   * Same-scheme renames go straight to the provider. Cross-scheme renames fall
   * back to `copyAcrossProviders` followed by deleting the source. Not atomic:
   * if the copy succeeds but deleting the source fails, the target keeps the
   * copied data and the thrown error lets the caller know the source remains.
   */
  async rename(source: URI, target: URI, opts?: { overwrite?: boolean }): Promise<void> {
    const { provider, uri } = this._resolve(source)
    const dst = reviveUri(target)
    if (dst.scheme !== uri.scheme) {
      const targetProvider = this.providers.get(dst.scheme)
      if (!targetProvider) {
        throw new FileSystemError(`Unsupported target scheme: ${dst.scheme}`, 'UNKNOWN')
      }
      const sourceStat = await provider.stat(uri)
      await copyAcrossProviders(provider, uri, targetProvider, dst, opts)
      try {
        await provider.delete(uri, { recursive: sourceStat.isDirectory })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new FileSystemError(
          `Cross-scheme rename copied '${uri}' -> '${dst}' but deleting the source failed (${message})`,
          error instanceof FileSystemError ? error.code : 'UNKNOWN',
        )
      }
      return
    }
    return provider.rename(uri, dst, opts)
  }

  /**
   * Same-scheme copies go straight to the provider. Cross-scheme copies fall
   * back to `copyAcrossProviders`, which is not transactional: a failure partway
   * through a directory leaves whatever was already copied behind, so the error
   * says so rather than implying the target is untouched.
   */
  async copy(source: URI, target: URI, opts?: { overwrite?: boolean }): Promise<void> {
    const { provider, uri } = this._resolve(source)
    const dst = reviveUri(target)
    if (dst.scheme !== uri.scheme) {
      const targetProvider = this.providers.get(dst.scheme)
      if (!targetProvider) {
        throw new FileSystemError(`Unsupported target scheme: ${dst.scheme}`, 'UNKNOWN')
      }
      try {
        return await copyAcrossProviders(provider, uri, targetProvider, dst, opts)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new FileSystemError(
          `Cross-scheme copy '${uri}' -> '${dst}' failed (${message}); the target may be partially written`,
          error instanceof FileSystemError ? error.code : 'UNKNOWN',
        )
      }
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

/**
 * Recursion cap for cross-provider directory walks. Real trees never come close;
 * a directory symlink pointing at an ancestor would otherwise recurse forever.
 */
export const MAX_COPY_DEPTH = 64

/**
 * Copies `sourceUri` (on `sourceProvider`) to `targetUri` (on `targetProvider`)
 * through read + write — the fallback for `FileService` cross-scheme copy /
 * rename, and directly reusable by main-process code that owns provider
 * instances (e.g. materializing remote files into a local temp directory).
 *
 * - Symlinks are followed: the content the link points to is copied, not the
 *   link itself (`stat`/`list` already report the target's kind). A directory
 *   symlink pointing at an ancestor would recurse forever, so the walk is
 *   capped at `MAX_COPY_DEPTH` levels and throws `ELOOP` past it — a visited
 *   set cannot catch this, since every level of `a/link/link/…` is a distinct
 *   URI.
 * - With `overwrite: true`, directories merge: an existing target directory is
 *   reused, same-name files are overwritten and extra entries in the target are
 *   never deleted. A file/directory kind mismatch throws `EEXIST`.
 * - Files are copied strictly serially, buffering one file at a time. v1 cannot
 *   copy a single file larger than the provider's read limit
 *   (NodeFileSystemProvider: 1GB binary / 256MB text) — the provider's
 *   `FileTooLarge` propagates as-is.
 * - Not transactional: a failure partway through a directory leaves the entries
 *   copied so far in place. Callers that surface the error should not imply the
 *   target is untouched.
 */
export async function copyAcrossProviders(
  sourceProvider: IFileSystemProvider,
  sourceUri: URI,
  targetProvider: IFileSystemProvider,
  targetUri: URI,
  opts?: {
    overwrite?: boolean
    /** Only honored when the caller holds the provider instances directly (main process); not part of `IFileService` because ProxyChannel cannot transport callbacks. */
    progress?: (transferred: number, totalBytes: number) => void
  },
): Promise<void> {
  const overwrite = opts?.overwrite ?? false
  const progress = opts?.progress

  console.info(
    `[FileService] cross-provider copy '${sourceUri}' -> '${targetUri}' (overwrite=${overwrite})`,
  )

  const sourceStat = await sourceProvider.stat(sourceUri)

  let totalBytes = 0
  if (progress) {
    totalBytes = await measureTreeBytes(sourceProvider, sourceUri, sourceStat)
    progress(0, totalBytes)
  }

  let transferred = 0
  const reportBytes = (bytes: number) => {
    if (!progress) return
    transferred += bytes
    progress(transferred, totalBytes)
  }

  if (sourceStat.isFile) {
    await copyFileEntry(
      sourceProvider,
      sourceUri,
      targetProvider,
      targetUri,
      overwrite,
      reportBytes,
    )
  } else {
    await copyDirectoryTree(
      sourceProvider,
      sourceUri,
      targetProvider,
      targetUri,
      overwrite,
      reportBytes,
      0,
    )
  }
}

async function copyFileEntry(
  sourceProvider: IFileSystemProvider,
  sourceUri: URI,
  targetProvider: IFileSystemProvider,
  targetUri: URI,
  overwrite: boolean,
  reportBytes: (bytes: number) => void,
): Promise<void> {
  const targetExists = await targetProvider.exists(targetUri)
  if (targetExists) {
    if (!overwrite) {
      throw new FileSystemError(`Target already exists: '${targetUri}'`, 'EEXIST')
    }
    const targetStat = await targetProvider.stat(targetUri)
    if (!targetStat.isFile) {
      throw new FileSystemError(`Cannot overwrite directory '${targetUri}' with a file`, 'EEXIST')
    }
  }
  const content = await sourceProvider.readFile(sourceUri)
  await targetProvider.writeFile(targetUri, content)
  reportBytes(content.byteLength)
}

async function copyDirectoryTree(
  sourceProvider: IFileSystemProvider,
  sourceUri: URI,
  targetProvider: IFileSystemProvider,
  targetUri: URI,
  overwrite: boolean,
  reportBytes: (bytes: number) => void,
  depth: number,
): Promise<void> {
  if (depth > MAX_COPY_DEPTH) {
    throw new FileSystemError(
      `Directory nesting exceeds ${MAX_COPY_DEPTH} levels at '${sourceUri}' (symlink cycle?)`,
      'ELOOP',
    )
  }
  const targetExists = await targetProvider.exists(targetUri)
  if (targetExists) {
    if (!overwrite) {
      throw new FileSystemError(`Target already exists: '${targetUri}'`, 'EEXIST')
    }
    const targetStat = await targetProvider.stat(targetUri)
    if (!targetStat.isDirectory) {
      throw new FileSystemError(
        `Cannot merge directory '${sourceUri}' into file '${targetUri}'`,
        'EEXIST',
      )
    }
  } else {
    await targetProvider.createDirectory(targetUri)
  }
  for (const entry of await sourceProvider.list(sourceUri)) {
    const childSource = URI.joinPath(sourceUri, entry.name)
    const childTarget = URI.joinPath(targetUri, entry.name)
    if (entry.isDirectory) {
      await copyDirectoryTree(
        sourceProvider,
        childSource,
        targetProvider,
        childTarget,
        overwrite,
        reportBytes,
        depth + 1,
      )
    } else {
      await copyFileEntry(
        sourceProvider,
        childSource,
        targetProvider,
        childTarget,
        overwrite,
        reportBytes,
      )
    }
  }
}

/** Sums file sizes of the tree for the progress total (only run when a progress callback is given). */
async function measureTreeBytes(
  provider: IFileSystemProvider,
  uri: URI,
  stat: IFileStat,
  depth = 0,
): Promise<number> {
  if (stat.isFile) return stat.size
  if (depth > MAX_COPY_DEPTH) {
    throw new FileSystemError(
      `Directory nesting exceeds ${MAX_COPY_DEPTH} levels at '${uri}' (symlink cycle?)`,
      'ELOOP',
    )
  }
  let total = 0
  for (const entry of await provider.list(uri)) {
    const child = URI.joinPath(uri, entry.name)
    const childStat = await provider.stat(child)
    total += childStat.isFile
      ? childStat.size
      : await measureTreeBytes(provider, child, childStat, depth + 1)
  }
  return total
}
