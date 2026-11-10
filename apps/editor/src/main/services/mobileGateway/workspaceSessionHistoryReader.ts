/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Read-only view of a workspace's persisted ACP session history bucket.
 *
 *  The renderer owns writes through IStorageService; main only needs the
 *  catalog for closed workspaces, so this module parses `state.json`-shaped
 *  bucket files directly. It never writes or renames anything (a corrupt file
 *  is left untouched) and applies the same resumable-row rules as the bridge.
 *--------------------------------------------------------------------------------------------*/

import { readFile, stat } from 'node:fs/promises'
import {
  normalizePlatform,
  URI,
  UriIdentityService,
  type HostPlatform,
  type ILogger,
} from '@universe-editor/platform'
import {
  MAX_HISTORY_PROMPT_LENGTH,
  MAX_ID_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_WORKSPACE_NAME_LENGTH,
  clampText,
} from '@universe-editor/mobile-protocol'
import type { MobileBridgeSessionHistoryEntry } from '../../../shared/ipc/mobileGatewayService.js'
import {
  ACP_SESSION_HISTORY_ACCEPTED_SCHEMA_VERSIONS,
  ACP_SESSION_HISTORY_STORAGE_KEY,
  isResumableHistoryEntry,
  type ResumableHistoryEntry,
} from '../../../shared/mobileGateway/sessionHistoryFilter.js'
import { workspaceIdFromUri, workspaceStoragePathFor } from '../../storage.js'

/** A single bucket above this is treated as corrupt rather than read whole. */
const MAX_HISTORY_BUCKET_BYTES = 16 * 1024 * 1024

export interface WorkspaceSessionHistoryReaderOptions {
  readonly userDataDir: string
  readonly logger: Pick<ILogger, 'debug' | 'warn'>
  /** Test override; production compares paths on the host platform. */
  readonly platform?: HostPlatform
}

export interface WorkspaceHistoryScope {
  /** Workspace folder URI string, exactly the form used for the storage bucket. */
  readonly folder: string
  readonly authority?: string
}

interface PersistedHistoryEntry extends ResumableHistoryEntry {
  readonly sessionIdOnAgent: string
  readonly agentId: string
  readonly title: string
  readonly firstPrompt?: string
  readonly createdAt: number
  readonly lastUsedAt: number
  readonly pinned?: boolean
}

export class WorkspaceSessionHistoryReader {
  private readonly _pathIdentity: UriIdentityService

  constructor(private readonly _options: WorkspaceSessionHistoryReaderOptions) {
    this._pathIdentity = new UriIdentityService(
      this._options.platform ?? normalizePlatform(process.platform),
    )
  }

  async read(
    workspace: WorkspaceHistoryScope,
  ): Promise<readonly MobileBridgeSessionHistoryEntry[]> {
    let folderUri: URI
    try {
      folderUri = URI.parse(workspace.folder)
    } catch (err) {
      this._options.logger.debug(
        `mobile history bucket skipped: invalid folder URI (${String(err)})`,
      )
      return []
    }

    const file = workspaceStoragePathFor(
      this._options.userDataDir,
      workspaceIdFromUri(workspace.folder),
    )
    let text: string
    try {
      const info = await stat(file)
      if (info.size > MAX_HISTORY_BUCKET_BYTES) {
        this._options.logger.debug(
          `mobile history bucket skipped: file is ${info.size} bytes (cap ${MAX_HISTORY_BUCKET_BYTES})`,
        )
        return []
      }
      text = await readFile(file, 'utf8')
    } catch (err) {
      this._options.logger.debug(`mobile history bucket unavailable: ${describe(err)}`)
      return []
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(stripBom(text))
    } catch (err) {
      this._options.logger.debug(
        `mobile history bucket is not valid JSON; keeping it untouched (${describe(err)})`,
      )
      return []
    }
    if (!isRecord(parsed)) return []

    const history = parsed[ACP_SESSION_HISTORY_STORAGE_KEY]
    if (!isRecord(history)) return []
    const schemaVersion = history['schemaVersion']
    if (
      typeof schemaVersion !== 'number' ||
      !ACP_SESSION_HISTORY_ACCEPTED_SCHEMA_VERSIONS.includes(schemaVersion)
    ) {
      this._options.logger.debug(
        `mobile history bucket skipped: unsupported schemaVersion=${String(schemaVersion)}`,
      )
      return []
    }
    const entries = history['entries']
    if (!Array.isArray(entries)) return []
    const deleted = new Set(
      Array.isArray(history['deleted'])
        ? history['deleted'].filter((id): id is string => typeof id === 'string')
        : [],
    )

    const authority =
      workspace.authority ?? (folderUri.authority !== '' ? folderUri.authority : undefined)
    const rows: MobileBridgeSessionHistoryEntry[] = []
    for (const candidate of entries) {
      if (!isPersistedHistoryEntry(candidate)) continue
      const entry: PersistedHistoryEntry = {
        ...candidate,
        // Older payloads may carry a different id; the renderer normalizes the
        // same way on load so lookups by durable id never miss.
        id: candidate.id === candidate.sessionIdOnAgent ? candidate.id : candidate.sessionIdOnAgent,
      }
      if (!isResumableHistoryEntry(entry, folderUri.fsPath, authority, this._pathIdentity)) {
        continue
      }
      if (deleted.has(entry.id)) continue
      const durableId = clampText(entry.id, MAX_ID_LENGTH)
      const agentId = clampText(entry.agentId, MAX_ID_LENGTH)
      if (durableId === '' || agentId === '') continue
      if (!Number.isFinite(entry.createdAt) || !Number.isFinite(entry.lastUsedAt)) continue
      const firstPrompt = entry.firstPrompt?.trim()
      rows.push({
        durableId,
        agentId,
        title: clampText(entry.title.length > 0 ? entry.title : durableId, MAX_TITLE_LENGTH),
        ...(firstPrompt !== undefined && firstPrompt.length > 0
          ? { firstPrompt: clampText(firstPrompt, MAX_HISTORY_PROMPT_LENGTH) }
          : {}),
        ...(entry.cwd !== undefined
          ? { cwd: clampText(entry.cwd, MAX_WORKSPACE_NAME_LENGTH) }
          : {}),
        ...(entry.authority !== undefined
          ? { authority: clampText(entry.authority, MAX_WORKSPACE_NAME_LENGTH) }
          : {}),
        createdAt: entry.createdAt,
        lastUsedAt: entry.lastUsedAt,
        ...(entry.pinned === true ? { pinned: true } : {}),
      })
    }
    return rows
  }
}

function isPersistedHistoryEntry(value: unknown): value is PersistedHistoryEntry {
  if (!isRecord(value)) return false
  return (
    typeof value['id'] === 'string' &&
    typeof value['sessionIdOnAgent'] === 'string' &&
    typeof value['agentId'] === 'string' &&
    typeof value['title'] === 'string' &&
    typeof value['createdAt'] === 'number' &&
    typeof value['lastUsedAt'] === 'number' &&
    (value['cwd'] === undefined || typeof value['cwd'] === 'string') &&
    (value['authority'] === undefined || typeof value['authority'] === 'string') &&
    (value['firstPrompt'] === undefined || typeof value['firstPrompt'] === 'string') &&
    (value['pinned'] === undefined || typeof value['pinned'] === 'boolean') &&
    (value['sideTaskOf'] === undefined || typeof value['sideTaskOf'] === 'string') &&
    (value['archived'] === undefined || typeof value['archived'] === 'boolean') &&
    (value['hasMessages'] === undefined || typeof value['hasMessages'] === 'boolean')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
