/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process filesystem gateway. Implements IFileService over `fs.promises`,
 *  reached from the renderer through ProxyChannel.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  createNamedLogger,
  FileSystemError,
  type IDirectoryEntry,
  type IFileService,
  type IFileStat,
  type ILogger,
  ILoggerService,
  URI,
  type UriComponents,
} from '@universe-editor/platform'

type RawUri = URI | UriComponents | string

function reviveUri(value: RawUri): URI {
  if (value instanceof URI) return value
  if (typeof value === 'string') return URI.parse(value)
  return URI.revive(value as UriComponents) as URI
}

function ensureFile(resource: URI): URI {
  if (resource.scheme !== 'file') {
    throw new FileSystemError(`Unsupported scheme: ${resource.scheme}`, 'UNKNOWN')
  }
  return resource
}

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

export class FileSystemMainService implements IFileService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger

  constructor(@ILoggerService loggerService?: ILoggerService) {
    this._logger = createNamedLogger(loggerService, { id: 'fileSystem', name: 'File System' })
  }

  async readFile(resource: RawUri): Promise<Uint8Array> {
    const uri = ensureFile(reviveUri(resource))
    try {
      const buf = await fs.readFile(uri.fsPath)
      this._logger.debug(`readFile ${uri.fsPath} bytes=${buf.byteLength}`)
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    } catch (err) {
      const mapped = mapError(err, 'readFile failed')
      this._logger.warn(`readFile failed ${uri.fsPath} code=${mapped.code}`, mapped.message)
      throw mapped
    }
  }

  async readFileText(resource: RawUri, encoding: 'utf8' = 'utf8'): Promise<string> {
    const uri = ensureFile(reviveUri(resource))
    try {
      const text = await fs.readFile(uri.fsPath, encoding)
      this._logger.debug(`readFileText ${uri.fsPath} chars=${text.length}`)
      return text
    } catch (err) {
      const mapped = mapError(err, 'readFileText failed')
      this._logger.warn(`readFileText failed ${uri.fsPath} code=${mapped.code}`, mapped.message)
      throw mapped
    }
  }

  async writeFile(resource: RawUri, content: Uint8Array | string): Promise<void> {
    const uri = ensureFile(reviveUri(resource))
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

  async exists(resource: RawUri): Promise<boolean> {
    const uri = ensureFile(reviveUri(resource))
    try {
      await fs.access(uri.fsPath)
      return true
    } catch {
      return false
    }
  }

  async stat(resource: RawUri): Promise<IFileStat> {
    const uri = ensureFile(reviveUri(resource))
    try {
      const s = await fs.stat(uri.fsPath)
      this._logger.debug(`stat ${uri.fsPath} size=${s.size} directory=${s.isDirectory()}`)
      return {
        resource: uri,
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        size: s.size,
        mtime: s.mtimeMs,
      }
    } catch (err) {
      const mapped = mapError(err, 'stat failed')
      this._logger.warn(`stat failed ${uri.fsPath} code=${mapped.code}`, mapped.message)
      throw mapped
    }
  }

  async list(resource: RawUri): Promise<IDirectoryEntry[]> {
    const uri = ensureFile(reviveUri(resource))
    try {
      const dirents = await fs.readdir(uri.fsPath, { withFileTypes: true })
      const entries = dirents.map((d) => ({
        name: d.name,
        isFile: d.isFile(),
        isDirectory: d.isDirectory(),
      }))
      this._logger.debug(`list ${uri.fsPath} entries=${entries.length}`)
      return entries
    } catch (err) {
      const mapped = mapError(err, 'list failed')
      this._logger.warn(`list failed ${uri.fsPath} code=${mapped.code}`, mapped.message)
      throw mapped
    }
  }

  async createDirectory(resource: RawUri): Promise<void> {
    const uri = ensureFile(reviveUri(resource))
    try {
      await fs.mkdir(uri.fsPath, { recursive: true })
      this._logger.info(`createDirectory ${uri.fsPath}`)
    } catch (err) {
      const mapped = mapError(err, 'createDirectory failed')
      this._logger.warn(`createDirectory failed ${uri.fsPath} code=${mapped.code}`, mapped.message)
      throw mapped
    }
  }

  async delete(resource: RawUri, opts?: { recursive?: boolean }): Promise<void> {
    const uri = ensureFile(reviveUri(resource))
    const recursive = opts?.recursive === true
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

  async rename(source: RawUri, target: RawUri, opts?: { overwrite?: boolean }): Promise<void> {
    const src = ensureFile(reviveUri(source))
    const dst = ensureFile(reviveUri(target))
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

  async copy(source: RawUri, target: RawUri, opts?: { overwrite?: boolean }): Promise<void> {
    const src = ensureFile(reviveUri(source))
    const dst = ensureFile(reviveUri(target))
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
    resource: RawUri,
    options?: { ignore?: readonly string[]; maxFiles?: number; maxDepth?: number },
  ): Promise<string[]> {
    const root = ensureFile(reviveUri(resource))
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
    return results
  }
}
