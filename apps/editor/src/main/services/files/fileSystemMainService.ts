/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process filesystem gateway. Implements IFileService over `fs.promises`,
 *  reached from the renderer through ProxyChannel.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import {
  FileSystemError,
  type IDirectoryEntry,
  type IFileService,
  type IFileStat,
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
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EISDIR' || code === 'EEXIST') {
    return new FileSystemError(e.message ?? fallbackMessage, code)
  }
  return new FileSystemError(e?.message ?? fallbackMessage, 'UNKNOWN')
}

export class FileSystemMainService implements IFileService {
  declare readonly _serviceBrand: undefined

  async readFile(resource: RawUri): Promise<Uint8Array> {
    const uri = ensureFile(reviveUri(resource))
    try {
      const buf = await fs.readFile(uri.fsPath)
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    } catch (err) {
      throw mapError(err, 'readFile failed')
    }
  }

  async readFileText(resource: RawUri, encoding: 'utf8' = 'utf8'): Promise<string> {
    const uri = ensureFile(reviveUri(resource))
    try {
      return await fs.readFile(uri.fsPath, encoding)
    } catch (err) {
      throw mapError(err, 'readFileText failed')
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
    } catch (err) {
      throw mapError(err, 'writeFile failed')
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
      return {
        resource: uri,
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        size: s.size,
        mtime: s.mtimeMs,
      }
    } catch (err) {
      throw mapError(err, 'stat failed')
    }
  }

  async list(resource: RawUri): Promise<IDirectoryEntry[]> {
    const uri = ensureFile(reviveUri(resource))
    try {
      const dirents = await fs.readdir(uri.fsPath, { withFileTypes: true })
      return dirents.map((d) => ({
        name: d.name,
        isFile: d.isFile(),
        isDirectory: d.isDirectory(),
      }))
    } catch (err) {
      throw mapError(err, 'list failed')
    }
  }

  async createDirectory(resource: RawUri): Promise<void> {
    const uri = ensureFile(reviveUri(resource))
    try {
      await fs.mkdir(uri.fsPath, { recursive: true })
    } catch (err) {
      throw mapError(err, 'createDirectory failed')
    }
  }
}
