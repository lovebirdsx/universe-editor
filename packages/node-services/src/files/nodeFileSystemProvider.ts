/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The `file:` scheme provider: local disk over `fs.promises`, trash via an
 *  injected shell hook (the host supplies `shell.trashItem` or its remote
 *  equivalent). Electron-free so both apps/editor main and a remote Node server
 *  can register it into a scheme-routed FileService.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  FileSystemError,
  NullLogger,
  type IDirectoryEntry,
  type IFileStat,
  type IFileSystemProvider,
  type IFileSystemProviderCapabilities,
  type ILogger,
  URI,
} from '@universe-editor/platform'

function mapError(err: unknown, fallbackMessage: string): FileSystemError {
  const e = err as NodeJS.ErrnoException
  const code = e?.code
  if (
    code === 'ENOENT' ||
    code === 'EACCES' ||
    code === 'EISDIR' ||
    code === 'EEXIST' ||
    code === 'ENOTEMPTY'
  ) {
    return new FileSystemError(e.message ?? fallbackMessage, code)
  }
  return new FileSystemError(e?.message ?? fallbackMessage, 'UNKNOWN')
}

/** Read-side backstops against a single absurdly large allocation: a multi-GB
 *  `fs.readFile` (the `.vsidx` full-text-index crash was a 2GB `readFileText`)
 *  aborts the process with an OOM before any caller can react. Text is capped
 *  lower — no editor scenario legitimately reads >256MB of text whole — while
 *  binary keeps a higher ceiling because extensions (`workspace.fs.readFile`)
 *  legitimately load whole PDFs / images / videos. */
const DEFAULT_MAX_TEXT_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_BINARY_BYTES = 1024 * 1024 * 1024

export interface NodeFileSystemProviderOptions {
  /** Moves a native path to the OS trash. Absent → `useTrash` fails loud. */
  readonly trash?: (nativePath: string) => Promise<void>
  readonly logger?: ILogger
  /** Overridable read caps (tests shrink them to exercise the throw path). */
  readonly maxTextBytes?: number
  readonly maxBinaryBytes?: number
}

export class NodeFileSystemProvider implements IFileSystemProvider {
  readonly capabilities: IFileSystemProviderCapabilities = {
    pathCaseSensitive: process.platform === 'linux',
  }

  private readonly _trash: ((nativePath: string) => Promise<void>) | undefined
  private readonly _logger: ILogger
  private readonly _maxTextBytes: number
  private readonly _maxBinaryBytes: number

  constructor(options: NodeFileSystemProviderOptions = {}) {
    this._trash = options.trash
    this._logger = options.logger ?? new NullLogger()
    this._maxTextBytes = options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES
    this._maxBinaryBytes = options.maxBinaryBytes ?? DEFAULT_MAX_BINARY_BYTES
  }

  /** Reject a read that would allocate more than `maxBytes` in one shot. */
  private async _assertReadableSize(uri: URI, maxBytes: number): Promise<void> {
    const s = await fs.stat(uri.fsPath)
    if (s.size <= maxBytes) return
    throw new FileSystemError(
      `File too large to read: ${uri.fsPath} is ${(s.size / 1024 / 1024).toFixed(1)}MB (limit ${(maxBytes / 1024 / 1024).toFixed(0)}MB)`,
      'FileTooLarge',
    )
  }

  /** ENOENT is a normal "not there" answer callers handle (e.g. probing an
   *  optional file like `.mcp.json`); anything else is a genuine failure. */
  private _logReadFailure(op: string, uri: URI, mapped: FileSystemError): void {
    const msg = `${op} failed ${uri.fsPath} code=${mapped.code}`
    if (mapped.code === 'ENOENT') this._logger.debug(msg, mapped.message)
    else this._logger.warn(msg, mapped.message)
  }

  async readFile(uri: URI): Promise<Uint8Array> {
    try {
      await this._assertReadableSize(uri, this._maxBinaryBytes)
      const buf = await fs.readFile(uri.fsPath)
      this._logger.debug(`readFile ${uri.fsPath} bytes=${buf.byteLength}`)
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    } catch (err) {
      const mapped = err instanceof FileSystemError ? err : mapError(err, 'readFile failed')
      this._logReadFailure('readFile', uri, mapped)
      throw mapped
    }
  }

  async readFileHead(uri: URI, maxBytes: number): Promise<Uint8Array> {
    try {
      const fd = await fs.open(uri.fsPath, 'r')
      try {
        const stat = await fd.stat()
        const length = Math.min(stat.size, maxBytes)
        const buf = new Uint8Array(length)
        const { bytesRead } = await fd.read(buf, 0, length, 0)
        this._logger.debug(`readFileHead ${uri.fsPath} bytes=${bytesRead}`)
        return buf.subarray(0, bytesRead)
      } finally {
        await fd.close()
      }
    } catch (err) {
      const mapped = err instanceof FileSystemError ? err : mapError(err, 'readFileHead failed')
      this._logReadFailure('readFileHead', uri, mapped)
      throw mapped
    }
  }

  async readFileText(uri: URI, encoding: 'utf8' = 'utf8'): Promise<string> {
    try {
      await this._assertReadableSize(uri, this._maxTextBytes)
      const text = await fs.readFile(uri.fsPath, encoding)
      this._logger.debug(`readFileText ${uri.fsPath} chars=${text.length}`)
      return text
    } catch (err) {
      const mapped = err instanceof FileSystemError ? err : mapError(err, 'readFileText failed')
      this._logReadFailure('readFileText', uri, mapped)
      throw mapped
    }
  }

  async writeFile(uri: URI, content: Uint8Array | string): Promise<void> {
    try {
      if (typeof content === 'string') {
        await fs.writeFile(uri.fsPath, content, 'utf8')
      } else {
        await fs.writeFile(
          uri.fsPath,
          Buffer.from(content.buffer, content.byteOffset, content.byteLength),
        )
      }
      const size = typeof content === 'string' ? content.length : content.byteLength
      this._logger.info(`writeFile ${uri.fsPath} bytes=${size}`)
    } catch (err) {
      const mapped = mapError(err, 'writeFile failed')
      this._logger.warn(`writeFile failed ${uri.fsPath} code=${mapped.code}`, mapped.message)
      throw mapped
    }
  }

  async exists(uri: URI): Promise<boolean> {
    try {
      await fs.access(uri.fsPath)
      return true
    } catch {
      return false
    }
  }

  async stat(uri: URI): Promise<IFileStat> {
    try {
      const lst = await fs.lstat(uri.fsPath)
      const isSymbolicLink = lst.isSymbolicLink()
      // Follow the link to report the target's type; fall back to the link
      // itself for dangling links (stat throws).
      const s = isSymbolicLink ? await fs.stat(uri.fsPath).catch(() => lst) : lst
      this._logger.debug(`stat ${uri.fsPath} size=${s.size} directory=${s.isDirectory()}`)
      return {
        resource: uri,
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        isSymbolicLink,
        size: s.size,
        mtime: s.mtimeMs,
      }
    } catch (err) {
      const mapped = mapError(err, 'stat failed')
      this._logReadFailure('stat', uri, mapped)
      throw mapped
    }
  }

  /**
   * Canonical, symlink-followed path. Resolves the longest existing prefix with
   * `fs.realpath` and re-appends the not-yet-created tail verbatim, so a target
   * that doesn't exist yet still reveals the real location of its parent. Never
   * fails with ENOENT.
   */
  async realpath(uri: URI): Promise<URI> {
    try {
      const real = await this._realpathString(uri.fsPath)
      this._logger.debug(`realpath ${uri.fsPath} -> ${real}`)
      return URI.file(real)
    } catch (err) {
      const mapped = mapError(err, 'realpath failed')
      this._logger.warn(`realpath failed ${uri.fsPath} code=${mapped.code}`, mapped.message)
      throw mapped
    }
  }

  private async _realpathString(target: string): Promise<string> {
    const tail: string[] = []
    let current = path.resolve(target)
    // Walk up until an existing ancestor is found; realpath that, then re-apply
    // the missing segments. A path whose every segment exists resolves on the
    // first iteration.
    for (;;) {
      try {
        const resolved = await fs.realpath(current)
        return tail.length === 0 ? resolved : path.join(resolved, ...tail)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        const parent = path.dirname(current)
        if (parent === current) {
          // Reached the filesystem root without an existing ancestor; nothing to
          // canonicalize, so hand back the normalized input.
          return path.resolve(target)
        }
        tail.unshift(path.basename(current))
        current = parent
      }
    }
  }

  async list(uri: URI): Promise<IDirectoryEntry[]> {
    try {
      const dirents = await fs.readdir(uri.fsPath, { withFileTypes: true })
      const entries = await Promise.all(
        dirents.map(async (d) => {
          // readdir Dirents carry lstat semantics: a symlink reports neither
          // file nor directory. Follow it to surface the target's type so a
          // directory link renders (and expands) as a folder.
          if (d.isSymbolicLink()) {
            try {
              const s = await fs.stat(path.join(uri.fsPath, d.name))
              return {
                name: d.name,
                isFile: s.isFile(),
                isDirectory: s.isDirectory(),
                isSymbolicLink: true,
              }
            } catch {
              return { name: d.name, isFile: false, isDirectory: false, isSymbolicLink: true }
            }
          }
          return {
            name: d.name,
            isFile: d.isFile(),
            isDirectory: d.isDirectory(),
            isSymbolicLink: false,
          }
        }),
      )
      this._logger.debug(`list ${uri.fsPath} entries=${entries.length}`)
      return entries
    } catch (err) {
      const mapped = mapError(err, 'list failed')
      this._logReadFailure('list', uri, mapped)
      throw mapped
    }
  }

  async listDrives(): Promise<string[]> {
    if (process.platform !== 'win32') return []
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
    const probed = await Promise.all(
      letters.map(async (letter) => {
        try {
          await fs.access(`${letter}:\\`)
          return `${letter}:`
        } catch {
          return undefined
        }
      }),
    )
    const drives = probed.filter((d): d is string => d !== undefined)
    this._logger.debug(`listDrives count=${drives.length}`)
    return drives
  }

  async createDirectory(uri: URI): Promise<void> {
    try {
      await fs.mkdir(uri.fsPath, { recursive: true })
      this._logger.info(`createDirectory ${uri.fsPath}`)
    } catch (err) {
      const mapped = mapError(err, 'createDirectory failed')
      this._logger.warn(`createDirectory failed ${uri.fsPath} code=${mapped.code}`, mapped.message)
      throw mapped
    }
  }

  async delete(uri: URI, opts?: { recursive?: boolean; useTrash?: boolean }): Promise<void> {
    const recursive = opts?.recursive === true
    if (opts?.useTrash === true) {
      if (!this._trash) {
        throw new FileSystemError('trash is not supported on this filesystem', 'UNKNOWN')
      }
      // shell.trashItem goes through the OS shell API (IFileOperation on
      // Windows), which rejects the forward-slash fsPath our URI produces —
      // normalize to the platform separator first.
      const trashPath = path.normalize(uri.fsPath)
      try {
        await this._trash(trashPath)
        this._logger.info(`delete (trash) ${trashPath}`)
      } catch (err) {
        const message =
          process.platform === 'win32'
            ? `Failed to move "${trashPath}" to the recycle bin`
            : `Failed to move "${trashPath}" to the trash`
        this._logger.warn(`delete (trash) failed ${trashPath}`, err)
        throw new FileSystemError(err instanceof Error ? err.message : message, 'UNKNOWN')
      }
      return
    }
    try {
      const s = await fs.stat(uri.fsPath)
      if (s.isDirectory()) {
        if (recursive) {
          await fs.rm(uri.fsPath, { recursive: true, force: false })
        } else {
          // rmdir surfaces ENOTEMPTY for non-empty directories on all platforms.
          await fs.rmdir(uri.fsPath)
        }
      } else {
        await fs.unlink(uri.fsPath)
      }
      this._logger.info(`delete ${uri.fsPath} recursive=${recursive}`)
    } catch (err) {
      const mapped = mapError(err, 'delete failed')
      this._logger.warn(`delete failed ${uri.fsPath} code=${mapped.code}`, mapped.message)
      throw mapped
    }
  }

  async rename(src: URI, dst: URI, opts?: { overwrite?: boolean }): Promise<void> {
    const overwrite = opts?.overwrite === true
    try {
      if (!overwrite) {
        let exists = true
        try {
          await fs.access(dst.fsPath)
        } catch {
          exists = false
        }
        if (exists) {
          throw new FileSystemError(`Target already exists: ${dst.fsPath}`, 'EEXIST')
        }
      }
      await fs.rename(src.fsPath, dst.fsPath)
      this._logger.info(`rename ${src.fsPath} -> ${dst.fsPath} overwrite=${overwrite}`)
    } catch (err) {
      const mapped = err instanceof FileSystemError ? err : mapError(err, 'rename failed')
      this._logger.warn(
        `rename failed ${src.fsPath} -> ${dst.fsPath} code=${mapped.code}`,
        mapped.message,
      )
      throw mapped
    }
  }

  async copy(src: URI, dst: URI, opts?: { overwrite?: boolean }): Promise<void> {
    const overwrite = opts?.overwrite === true
    try {
      if (!overwrite) {
        let exists = true
        try {
          await fs.access(dst.fsPath)
        } catch {
          exists = false
        }
        if (exists) {
          throw new FileSystemError(`Target already exists: ${dst.fsPath}`, 'EEXIST')
        }
      }
      await fs.cp(src.fsPath, dst.fsPath, { recursive: true, force: overwrite })
      this._logger.info(`copy ${src.fsPath} -> ${dst.fsPath} overwrite=${overwrite}`)
    } catch (err) {
      const mapped = err instanceof FileSystemError ? err : mapError(err, 'copy failed')
      this._logger.warn(
        `copy failed ${src.fsPath} -> ${dst.fsPath} code=${mapped.code}`,
        mapped.message,
      )
      throw mapped
    }
  }

  async listRecursive(
    root: URI,
    options?: { ignore?: readonly string[]; maxFiles?: number; maxDepth?: number },
  ): Promise<URI[]> {
    const ignore = new Set(options?.ignore ?? [])
    const maxFiles = options?.maxFiles ?? 5000
    const maxDepth = options?.maxDepth ?? 30
    const results: string[] = []

    const scan = async (dir: string, depth: number): Promise<void> => {
      if (results.length >= maxFiles || depth > maxDepth) return
      const dirents = await fs
        .readdir(dir, { withFileTypes: true, encoding: 'utf8' })
        .catch(() => null)
      if (!dirents) return
      const subdirs: string[] = []
      for (const d of dirents) {
        if (results.length >= maxFiles) return
        if (d.isDirectory()) {
          if (!ignore.has(d.name)) subdirs.push(path.join(dir, d.name))
        } else if (d.isFile()) {
          results.push(path.join(dir, d.name))
        }
      }
      await Promise.all(subdirs.map((sub) => scan(sub, depth + 1)))
    }

    await scan(root.fsPath, 0)
    this._logger.debug(
      `listRecursive ${root.fsPath} files=${results.length} maxFiles=${maxFiles} maxDepth=${maxDepth}`,
    )
    return results.map((p) => URI.file(p))
  }
}
