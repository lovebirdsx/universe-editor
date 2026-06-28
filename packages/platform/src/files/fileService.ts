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
  /** True when the entry is a symbolic link. `isFile`/`isDirectory` then reflect the link target. */
  readonly isSymbolicLink?: boolean
  readonly size: number
  /** Last-modified time as epoch milliseconds. */
  readonly mtime: number
}

export interface IDirectoryEntry {
  readonly name: string
  readonly isFile: boolean
  readonly isDirectory: boolean
  /** True when the entry is a symbolic link. `isFile`/`isDirectory` then reflect the link target. */
  readonly isSymbolicLink?: boolean
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

  /**
   * Resolves the canonical, symlink-followed path of `resource`. For a path that
   * doesn't fully exist yet, the longest existing prefix is resolved (following
   * any symlinks) and the not-yet-created tail is appended verbatim — so a
   * caller can still learn the real location of a target's parent directory.
   * Never throws `ENOENT`; other fs errors propagate as `FileSystemError`.
   *
   * Used as a defense-in-depth check by the extension/agent fs gateway: a
   * text-level path policy can be re-run against the real path to catch symlinks
   * that escape the workspace or point at sensitive locations. Optional:
   * implementations without symlink semantics may omit it.
   */
  realpath?(resource: URI): Promise<URI>

  /**
   * Enumerates the available drive roots (e.g. `['C:', 'D:']`) on Windows. On
   * other platforms there is a single filesystem root, so this returns `[]`.
   * Optional: filesystems without the notion of drives may omit it.
   */
  listDrives?(): Promise<string[]>

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
   * Copies `source` to `target` (recursively for directories). Without
   * `overwrite: true`, an existing target throws `FileSystemError('EEXIST')`.
   */
  copy(source: URI, target: URI, opts?: { overwrite?: boolean }): Promise<void>

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
