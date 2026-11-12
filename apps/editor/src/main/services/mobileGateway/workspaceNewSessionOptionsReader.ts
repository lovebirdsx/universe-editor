/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Read-only new-session defaults for one PC workspace:
 *
 *    1. `acp.lastSessionCwd` from the workspace storage bucket (written by the
 *       renderer whenever any session is created, desktop or phone),
 *    2. `acp.projectRoots` from the workspace settings (Project, then the
 *       read-only VSCode compatibility layer).
 *
 *  The phone only ever sees workspace-relative paths. Everything here is a
 *  best-effort read: a missing/corrupt bucket, an unreachable remote host, or
 *  an unparsable settings file degrades to an empty option instead of an error.
 *--------------------------------------------------------------------------------------------*/

import {
  isCaseInsensitive,
  normalizeFsPath,
  normalizePlatform,
  relativePathUnder,
  REMOTE_SCHEME,
  URI,
  type HostPlatform,
  type IFileService,
  type ILogger,
} from '@universe-editor/platform'
import {
  MAX_NEW_SESSION_PROJECT_ROOTS,
  parseWorkspaceRelativePath,
  type MobileNewSessionOptions,
} from '@universe-editor/mobile-protocol'
import { parse, type ParseError } from 'jsonc-parser'
import {
  ACP_LAST_SESSION_CWD_SCHEMA_VERSION,
  ACP_LAST_SESSION_CWD_STORAGE_KEY,
} from '../../../shared/acp/lastSessionCwdState.js'
import {
  configuredProjectRootEntries,
  PROJECT_ROOTS_KEY,
  resolveConfiguredProjectRoot,
} from '../../../shared/acp/projectRoots.js'
import {
  describeFsError,
  isUnavailablePathError,
} from '../../../shared/mobileGateway/workspaceFsErrors.js'
import { isPathWithinWorkspace } from '../../../shared/mobileGateway/workspacePathScope.js'
import {
  DEFAULT_WORKSPACE_STATE_BUCKET_MAX_BYTES,
  readWorkspaceStateBucket,
  stripBom,
} from './workspaceStateBucket.js'

/** A settings file above this is treated as unreadable rather than parsed. */
const MAX_SETTINGS_FILE_BYTES = 1024 * 1024

export interface WorkspaceNewSessionOptionsTarget {
  /** Workspace root URI string (`file:///…` / `remote-ssh://…`). */
  readonly folder: string
  readonly authority?: string
}

export interface WorkspaceNewSessionOptionsReaderOptions {
  readonly userDataDir: string
  /** Without a file provider only the empty fallback is available. */
  readonly files?: IFileService
  readonly logger: Pick<ILogger, 'debug' | 'warn'>
  /** Test override; production compares paths on the host platform. */
  readonly platform?: HostPlatform
}

interface SettingsLayerRead {
  readonly defined: boolean
  readonly entries: readonly string[]
}

export class WorkspaceNewSessionOptionsReader {
  private readonly _platform: HostPlatform

  constructor(private readonly _options: WorkspaceNewSessionOptionsReaderOptions) {
    this._platform = _options.platform ?? normalizePlatform(process.platform)
  }

  async read(workspace: WorkspaceNewSessionOptionsTarget): Promise<MobileNewSessionOptions> {
    const files = this._options.files
    if (files === undefined) return { projectRoots: [] }

    let root: URI
    try {
      root = URI.parse(workspace.folder)
    } catch {
      this._options.logger.debug('new-session options skipped: invalid workspace folder')
      return { projectRoots: [] }
    }
    if (!root.scheme) {
      this._options.logger.debug('new-session options skipped: invalid workspace folder')
      return { projectRoots: [] }
    }

    // Remote-ssh always carries POSIX paths on the server; local workspaces use
    // the host platform (same rule as directory browsing).
    const platform: HostPlatform = root.scheme === REMOTE_SCHEME ? 'linux' : this._platform

    const [lastRelativePath, projectRoots] = await Promise.all([
      this._readLastRelativePath(root, workspace, platform).catch((err: unknown) => {
        this._options.logger.debug(`new-session last cwd read failed: ${describeFsError(err)}`)
        return undefined
      }),
      this._readProjectRoots(root, platform).catch((err: unknown) => {
        this._options.logger.debug(`new-session project roots read failed: ${describeFsError(err)}`)
        return [] as readonly string[]
      }),
    ])
    this._options.logger.debug(`new-session project roots inside workspace: ${projectRoots.length}`)
    return {
      ...(lastRelativePath !== undefined ? { lastRelativePath } : {}),
      projectRoots,
    }
  }

  // -- last created session directory -------------------------------------

  private async _readLastRelativePath(
    root: URI,
    workspace: WorkspaceNewSessionOptionsTarget,
    platform: HostPlatform,
  ): Promise<string | undefined> {
    const bucket = await readWorkspaceStateBucket({
      userDataDir: this._options.userDataDir,
      folder: workspace.folder,
      maxBytes: DEFAULT_WORKSPACE_STATE_BUCKET_MAX_BYTES,
      label: 'mobile new-session options bucket',
      logger: this._options.logger,
    })
    if (!bucket.ok) return undefined

    const raw = bucket.state[ACP_LAST_SESSION_CWD_STORAGE_KEY]
    if (!isRecord(raw)) return undefined
    if (raw['schemaVersion'] !== ACP_LAST_SESSION_CWD_SCHEMA_VERSION) return undefined
    const cwd = raw['cwd']
    if (typeof cwd !== 'string' || cwd.length === 0) return undefined
    const storedAuthority = raw['authority']
    if (storedAuthority !== undefined && typeof storedAuthority !== 'string') {
      return undefined
    }

    // The desktop gate compares authorities for every workspace (`undefined`
    // for local windows), so a row remembered against another host must not
    // seed this one.
    const expectedAuthority =
      root.scheme === REMOTE_SCHEME
        ? (workspace.authority ?? root.authority ?? undefined)
        : undefined
    if ((storedAuthority ?? undefined) !== expectedAuthority) return undefined

    const relative = relativePathWithinWorkspaceRoot(root, cwd, platform)
    if (relative === null || relative === '') return undefined
    const parsed = parseWorkspaceRelativePath(relative)
    if (parsed === null || parsed.path === '') return undefined

    const files = this._options.files
    if (files === undefined) return undefined
    const target = URI.joinPath(root, ...parsed.segments)
    try {
      const info = await files.stat(target)
      if (!info.isDirectory) return undefined
    } catch (err) {
      // A provider error (remote host unreachable, transport hiccup) is not
      // proof the directory is gone — keep the memory, matching the desktop
      // `AcpLastSessionCwdService` probe. Only an unavailable path drops it.
      if (isUnavailablePathError(err)) return undefined
    }

    const realpath = files.realpath?.bind(files)
    if (realpath !== undefined) {
      try {
        const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)])
        if (!isPathWithinWorkspace(realRoot, realTarget, platform)) return undefined
      } catch (err) {
        if (isUnavailablePathError(err)) return undefined
      }
    }
    return parsed.path
  }

  // -- configured project roots -------------------------------------------

  private async _readProjectRoots(root: URI, platform: HostPlatform): Promise<readonly string[]> {
    const projectFile = URI.joinPath(root, '.universe-editor', 'settings.json')
    const project = await this._readSettingsLayer(projectFile)
    const entries = project.defined
      ? project.entries
      : (await this._readSettingsLayer(URI.joinPath(root, '.vscode', 'settings.json'))).entries

    const roots: string[] = []
    const seen = new Set<string>()
    for (const entry of entries) {
      let resolved: URI
      try {
        resolved = resolveConfiguredProjectRoot(root, entry, this._platform)
      } catch (err) {
        this._options.logger.debug(
          `ignoring unresolvable ${PROJECT_ROOTS_KEY} entry: ${describeFsError(err)}`,
        )
        continue
      }
      if (!isPathWithinWorkspace(root, resolved, this._platform)) continue
      const relative = relativePathWithinWorkspaceRoot(root, resolved.fsPath, platform)
      if (relative === null || relative === '') continue
      const parsed = parseWorkspaceRelativePath(relative)
      if (parsed === null || parsed.path === '') continue
      const key = isCaseInsensitive(platform) ? parsed.path.toLowerCase() : parsed.path
      if (seen.has(key)) continue
      seen.add(key)
      roots.push(parsed.path)
      if (roots.length >= MAX_NEW_SESSION_PROJECT_ROOTS) break
    }
    return roots
  }

  private async _readSettingsLayer(file: URI): Promise<SettingsLayerRead> {
    const files = this._options.files
    if (files === undefined) return { defined: false, entries: [] }
    try {
      const info = await files.stat(file)
      if (info.size > MAX_SETTINGS_FILE_BYTES) {
        this._options.logger.debug('workspace settings skipped: file is too large')
        return { defined: false, entries: [] }
      }
    } catch (err) {
      if (!isUnavailablePathError(err)) {
        this._options.logger.debug(`workspace settings stat failed: ${describeFsError(err)}`)
      }
      return { defined: false, entries: [] }
    }

    let text: string
    try {
      text = await files.readFileText(file, 'utf8')
    } catch (err) {
      this._options.logger.debug(`workspace settings read failed: ${describeFsError(err)}`)
      return { defined: false, entries: [] }
    }

    const errors: ParseError[] = []
    const parsed: unknown = parse(stripBom(text), errors, { allowTrailingComma: true })
    if (errors.length > 0 || !isRecord(parsed)) return { defined: false, entries: [] }
    if (!Object.prototype.hasOwnProperty.call(parsed, PROJECT_ROOTS_KEY)) {
      return { defined: false, entries: [] }
    }
    return { defined: true, entries: configuredProjectRootEntries(parsed[PROJECT_ROOTS_KEY]) }
  }
}

/**
 * String-level relative path under the workspace root (`''` when equal).
 * Remote POSIX roots need the `/` special case because `relativePathUnder`
 * tests for a `${root}/` prefix, which can never match the root itself.
 */
function relativePathWithinWorkspaceRoot(
  root: URI,
  candidatePath: string,
  platform: HostPlatform,
): string | null {
  if (normalizeFsPath(root.fsPath) === '/') {
    const normalized = normalizeFsPath(candidatePath)
    if (!normalized.startsWith('/') || normalized === '/') return null
    return normalized.slice(1)
  }
  return relativePathUnder(root.fsPath, candidatePath, platform)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
