/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Read-only directory browsing for the phone's new-session picker. The phone
 *  only ever sees workspace-relative directory names; absolute paths, file
 *  contents, and symlink targets never cross the wire.
 *--------------------------------------------------------------------------------------------*/

import {
  normalizePlatform,
  URI,
  type HostPlatform,
  type IFileService,
  type ILogger,
} from '@universe-editor/platform'
import {
  appendWorkspaceRelativePath,
  parentWorkspaceRelativePath,
  parseWorkspaceRelativePath,
  type MobileDirectoryEntry,
  type MobileDirectoryListing,
} from '@universe-editor/mobile-protocol'
import { isPathWithinWorkspace } from '../../../shared/mobileGateway/workspacePathScope.js'
import {
  describeFsError,
  isUnavailablePathError,
} from '../../../shared/mobileGateway/workspaceFsErrors.js'

/** The phone frame budget is 1 MiB; keep the listing far below it. */
export const MAX_DIRECTORY_ENTRIES = 500
export const MAX_DIRECTORY_LISTING_CHARS = 256 * 1024

export type WorkspaceDirectoryBrowseErrorCode = 'bad_request' | 'internal'

export class WorkspaceDirectoryBrowseError extends Error {
  constructor(
    readonly code: WorkspaceDirectoryBrowseErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'WorkspaceDirectoryBrowseError'
  }
}

export interface WorkspaceDirectoryBrowserOptions {
  readonly logger?: ILogger
  /** Overridable for cross-platform unit tests. */
  readonly platform?: HostPlatform
}

export interface WorkspaceDirectoryTarget {
  /** Workspace root URI string (`file:///…` / `remote-ssh://…`). */
  readonly folder: string
  readonly authority?: string
}

/**
 * Lists one workspace-relative directory. Callers (the mobile hub) must have
 * matched `folder` against the PC's open/recent workspaces first; this class
 * only guarantees that the requested path stays inside that root.
 */
export class WorkspaceDirectoryBrowser {
  private readonly _platform: HostPlatform

  constructor(
    private readonly _files: IFileService,
    private readonly _options: WorkspaceDirectoryBrowserOptions = {},
  ) {
    this._platform = _options.platform ?? normalizePlatform(process.platform)
  }

  async read(
    workspace: WorkspaceDirectoryTarget,
    relativePath: string | undefined,
  ): Promise<MobileDirectoryListing> {
    const parsed = parseWorkspaceRelativePath(relativePath)
    if (parsed === null) {
      throw new WorkspaceDirectoryBrowseError('bad_request', 'invalid workspace-relative path')
    }
    let root: URI
    try {
      root = URI.parse(workspace.folder)
    } catch {
      throw new WorkspaceDirectoryBrowseError('bad_request', 'invalid workspace folder')
    }
    if (!root.scheme) {
      throw new WorkspaceDirectoryBrowseError('bad_request', 'invalid workspace folder')
    }
    const target = parsed.segments.length === 0 ? root : URI.joinPath(root, ...parsed.segments)

    let isDirectory = false
    try {
      isDirectory = (await this._files.stat(target)).isDirectory
    } catch (err) {
      throw this._mapFsError(err, 'workspace directory stat failed')
    }
    if (!isDirectory) {
      throw new WorkspaceDirectoryBrowseError('bad_request', 'target is not a directory')
    }
    await this._assertRealPathWithin(root, target)

    let rawEntries
    try {
      rawEntries = await this._files.list(target)
    } catch (err) {
      throw this._mapFsError(err, 'workspace directory list failed')
    }

    const directories: MobileDirectoryEntry[] = []
    for (const entry of rawEntries) {
      if (!entry.isDirectory) continue
      const childPath = appendWorkspaceRelativePath(parsed.path, entry.name)
      if (childPath === null) {
        // POSIX allows backslashes in names; the wire path cannot represent
        // them unambiguously, so such entries are not browsable.
        this._options.logger?.debug('workspace directory entry skipped: non-canonical name')
        continue
      }
      directories.push({ name: entry.name, relativePath: childPath })
    }
    directories.sort(compareDirectoryEntries)

    const entries: MobileDirectoryEntry[] = []
    let chars = 0
    let truncated = false
    for (const entry of directories) {
      if (entries.length >= MAX_DIRECTORY_ENTRIES) {
        truncated = true
        break
      }
      const cost = entry.name.length + entry.relativePath.length
      if (chars + cost > MAX_DIRECTORY_LISTING_CHARS) {
        truncated = true
        break
      }
      chars += cost
      entries.push(entry)
    }

    const parentRelativePath = parentWorkspaceRelativePath(parsed.path)
    return {
      relativePath: parsed.path,
      ...(parentRelativePath !== undefined ? { parentRelativePath } : {}),
      entries,
      ...(truncated ? { truncated: true } : {}),
    }
  }

  /**
   * The lexical join above already keeps `..` out of the path, but a symlink
   * inside the workspace may still point elsewhere. `realpath` never throws
   * ENOENT; the stat above is what proves existence.
   */
  private async _assertRealPathWithin(root: URI, target: URI): Promise<void> {
    const realpath = this._files.realpath?.bind(this._files)
    if (realpath === undefined) return
    let realRoot: URI
    let realTarget: URI
    try {
      realRoot = await realpath(root)
      realTarget = await realpath(target)
    } catch (err) {
      this._options.logger?.debug(`workspace directory realpath failed: ${describeFsError(err)}`)
      throw new WorkspaceDirectoryBrowseError(
        isUnavailablePathError(err) ? 'bad_request' : 'internal',
        'directory resolution failed',
      )
    }
    if (!isPathWithinWorkspace(realRoot, realTarget, this._platform)) {
      throw new WorkspaceDirectoryBrowseError(
        'bad_request',
        'directory resolves outside the workspace',
      )
    }
  }

  private _mapFsError(err: unknown, message: string): WorkspaceDirectoryBrowseError {
    const kind: WorkspaceDirectoryBrowseErrorCode = isUnavailablePathError(err)
      ? 'bad_request'
      : 'internal'
    this._options.logger?.debug(`${message}: ${describeFsError(err)}`)
    return new WorkspaceDirectoryBrowseError(kind, message)
  }
}

function compareDirectoryEntries(a: MobileDirectoryEntry, b: MobileDirectoryEntry): number {
  const folded = a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
  if (folded !== 0) return folded
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}
