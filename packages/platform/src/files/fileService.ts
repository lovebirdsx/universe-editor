/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IFileService (workbench/services/files).
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../di/instantiation.js'
import type { URI } from '../base/uri.js'

export type FileSystemErrorCode =
  | 'ENOENT'
  | 'EACCES'
  | 'EISDIR'
  | 'EEXIST'
  | 'ENOTEMPTY'
  | 'UNKNOWN'

export class FileSystemError extends Error {
  readonly code: FileSystemErrorCode
  constructor(message: string, code: FileSystemErrorCode = 'UNKNOWN') {
    super(message)
    this.code = code
    this.name = 'FileSystemError'
  }
}

export interface IFileStat {
  readonly resource: URI
  readonly isFile: boolean
  readonly isDirectory: boolean
  readonly size: number
  /** Last-modified time as epoch milliseconds. */
  readonly mtime: number
}

export interface IDirectoryEntry {
  readonly name: string
  readonly isFile: boolean
  readonly isDirectory: boolean
}

/**
 * Cross-process filesystem gateway. Implementations live on the main side and
 * are reached from the renderer through `ProxyChannel.toService<IFileService>`.
 * URIs must use the `file:` scheme; non-file schemes throw `FileSystemError`.
 */
export interface IFileService {
  readonly _serviceBrand: undefined

  readFile(resource: URI): Promise<Uint8Array>
  readFileText(resource: URI, encoding?: 'utf8'): Promise<string>
  writeFile(resource: URI, content: Uint8Array | string): Promise<void>

  exists(resource: URI): Promise<boolean>
  stat(resource: URI): Promise<IFileStat>
  list(resource: URI): Promise<IDirectoryEntry[]>
  createDirectory(resource: URI): Promise<void>

  /**
   * Deletes a file or directory. For directories, callers must opt in with
   * `recursive: true` to remove non-empty trees; otherwise removing a
   * non-empty directory throws `FileSystemError('ENOTEMPTY')`.
   */
  delete(resource: URI, opts?: { recursive?: boolean }): Promise<void>

  /**
   * Renames or moves `source` to `target`. Without `overwrite: true`, an
   * existing target throws `FileSystemError('EEXIST')`. Cross-device moves
   * are not guaranteed and may throw `UNKNOWN`.
   */
  rename(source: URI, target: URI, opts?: { overwrite?: boolean }): Promise<void>

  /**
   * Recursively lists all files under `root`, skipping directories named in
   * `ignore`. Returns absolute fsPath strings to avoid URI serialization over IPC.
   */
  listRecursive(
    root: URI,
    options?: { ignore?: readonly string[]; maxFiles?: number; maxDepth?: number },
  ): Promise<string[]>
}

export const IFileService = createDecorator<IFileService>('fileService')
