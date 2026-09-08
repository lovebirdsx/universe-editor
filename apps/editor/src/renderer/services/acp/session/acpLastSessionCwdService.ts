/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpLastSessionCwdService — remembers the working directory of the most
 *  recently created session so a brand new session defaults to it instead of
 *  always falling back to the workspace root.
 *
 *  Single last-wins value (not per-agent): the user almost always works in one
 *  area at a time, and any createSession — explicit scope pick or plain
 *  Ctrl+Alt+N — counts as "the last one".
 *
 *  Scope follows the same workspace-first + global-fallback policy as session
 *  history and agent defaults (delegated to `PersistedStateBase`): the cwd
 *  remembered in workspace-A never leaks into workspace-B's new sessions.
 *
 *  Stale-directory handling: `remember` kicks a debounced background
 *  `IFileService.exists` probe; when the directory turns out to be gone the
 *  memory is cleared silently so the next default falls back to the workspace
 *  root. The synchronous read path (`lastCwd`) never does IO — `createSession`
 *  must stay synchronous.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  IFileService,
  ILoggerService,
  IStorageService,
  ITelemetryService,
  IUriIdentityService,
  IWorkspaceService,
  InstantiationType,
  registerSingleton,
  REMOTE_SCHEME,
  URI,
} from '@universe-editor/platform'
import { PersistedStateBase } from '../persistedStateBase.js'
import { isForeignWorkspaceSession } from './acpSessionHistory.js'

export interface IAcpLastSessionCwd {
  readonly cwd: string
  readonly authority?: string
}

/**
 * The current window's authority for a workspace folder: undefined for local
 * windows, the remote authority for `REMOTE_SCHEME` folders. Empty authority
 * collapses to undefined so it compares equal to the local case.
 */
export function authorityForFolder(folder: URI | undefined): string | undefined {
  if (!folder || folder.scheme !== REMOTE_SCHEME) return undefined
  return folder.authority || undefined
}

/**
 * Build the URI for a remembered cwd. Local memories stay plain file URIs;
 * remote memories resolve against REMOTE_SCHEME so probes/dialogs hit the
 * right host. The path must carry exactly one leading slash — a bare
 * `C:/...` from a remote Windows host would serialize as
 * `universe-remote://host/C:/...` and parse unstably.
 */
export function rememberedCwdUri(cwd: string, authority: string | undefined): URI {
  if (authority === undefined) return URI.file(cwd)
  const path = cwd.startsWith('/') ? cwd : `/${cwd}`
  return URI.from({ scheme: REMOTE_SCHEME, authority, path })
}

/**
 * Single source of truth for "may this memory seed a new session's cwd in
 * this window": same host (authority match) and still inside the open folder
 * (not foreign). An empty window (no folder) accepts only the local memory —
 * the workspace-first/global-fallback bucket policy already scoped it.
 *
 * The facade's `_rememberedCwd`, the scope picker's `defaultUri`, and the
 * tests all delegate here so the gate cannot drift into multiple copies.
 */
export function rememberedCwdForWindow(
  remembered: IAcpLastSessionCwd | undefined,
  currentFolder: URI | undefined,
  uriIdentity: IUriIdentityService,
): string | undefined {
  if (!remembered) return undefined
  const currentAuthority = authorityForFolder(currentFolder)
  if (remembered.authority !== currentAuthority) return undefined
  if (
    currentFolder &&
    isForeignWorkspaceSession(remembered, currentFolder.fsPath, currentAuthority, uriIdentity)
  ) {
    return undefined
  }
  return remembered.cwd
}

export interface IAcpLastSessionCwdService {
  readonly _serviceBrand: undefined
  /** Idempotent. Kicked fire-and-forget from AcpInitContribution. */
  initialize(): Promise<void>
  /** Synchronous read — never does IO. Undefined when nothing is remembered. */
  lastCwd(): IAcpLastSessionCwd | undefined
  /** Record the cwd a session was just created with (last-wins). */
  remember(cwd: string, authority: string | undefined): void
  /** Drop the memory (e.g. the directory no longer exists). */
  clear(): void
}

export const IAcpLastSessionCwdService = createDecorator<IAcpLastSessionCwdService>(
  'acpLastSessionCwdService',
)

const STORAGE_KEY = 'acp.lastSessionCwd'
const SCHEMA_VERSION = 1

interface PersistedShape {
  readonly schemaVersion: number
  readonly cwd?: string
  readonly authority?: string
}

interface LastCwdState {
  readonly cwd?: string
  readonly authority?: string
}

export class AcpLastSessionCwdService
  extends PersistedStateBase<LastCwdState>
  implements IAcpLastSessionCwdService
{
  declare readonly _serviceBrand: undefined

  /** Serializes the debounced background exists probes (latest-wins). */
  private _probeGeneration = 0
  private _probeTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    @IStorageService storage: IStorageService,
    @IWorkspaceService workspace: IWorkspaceService,
    @ITelemetryService telemetry: ITelemetryService,
    @ILoggerService loggerService: ILoggerService,
    @IFileService private readonly _fileService: IFileService,
  ) {
    super(storage, workspace, telemetry, loggerService, {
      storageKey: STORAGE_KEY,
      loggerId: 'acpLastSessionCwd',
      loggerName: 'ACP Last Session Cwd',
      persistFailureEvent: 'acp.last_session_cwd_persist_failed',
    })
  }

  lastCwd(): IAcpLastSessionCwd | undefined {
    const { cwd, authority } = this._state
    if (cwd === undefined) return undefined
    return authority !== undefined ? { cwd, authority } : { cwd }
  }

  remember(cwd: string, authority: string | undefined): void {
    const cur = this._state
    if (cur.cwd === cwd && cur.authority === authority) return
    this._state = authority !== undefined ? { cwd, authority } : { cwd }
    this._scheduleWrite()
    this._scheduleProbe()
  }

  clear(): void {
    if (this._state.cwd === undefined) return
    this._state = {}
    this._scheduleWrite()
  }

  override dispose(): void {
    if (this._probeTimer) {
      clearTimeout(this._probeTimer)
      this._probeTimer = undefined
    }
    super.dispose()
  }

  // -- background staleness probe ----------------------------------------

  /**
   * Debounced + latest-wins: rapid successive creates collapse into one probe
   * of the newest directory. A probe result is only applied when it still
   * targets the current memory (the user may have created another session
   * meanwhile).
   */
  private _scheduleProbe(): void {
    if (this._probeTimer) clearTimeout(this._probeTimer)
    const generation = ++this._probeGeneration
    this._probeTimer = setTimeout(() => {
      this._probeTimer = undefined
      void this._probe(generation)
    }, 100)
  }

  private async _probe(generation: number): Promise<void> {
    const { cwd, authority } = this._state
    if (cwd === undefined) return
    let exists: boolean
    try {
      exists = await this._fileService.exists(rememberedCwdUri(cwd, authority))
    } catch {
      // A probe *failure* (remote host unreachable, transport hiccup) is not
      // proof the directory is gone — keep the memory rather than silently
      // dropping it on every connection blip. Only a clean `false` clears.
      return
    }
    if (generation !== this._probeGeneration) return
    if (this._state.cwd !== cwd || this._state.authority !== authority) return
    if (this._store.isDisposed) return
    if (!exists) {
      this._logger.info(`clearing remembered session cwd (no longer exists): ${cwd}`)
      this.clear()
    }
  }

  // -- PersistedStateBase hooks ------------------------------------------

  protected override _emptyState(): LastCwdState {
    return {}
  }

  /**
   * A cwd remembered before the load completed (a session created during the
   * cold-start window or mid workspace-swap) wins over the persisted row —
   * otherwise the stale load would silently overwrite the fresher memory.
   * Single last-wins value, so "current non-empty" is the whole merge rule.
   */
  protected override _mergeOnLoad(loaded: LastCwdState, current: LastCwdState): LastCwdState {
    return current.cwd !== undefined ? current : loaded
  }

  protected override _serialize(state: LastCwdState): PersistedShape {
    return {
      schemaVersion: SCHEMA_VERSION,
      ...(state.cwd !== undefined ? { cwd: state.cwd } : {}),
      ...(state.authority !== undefined ? { authority: state.authority } : {}),
    }
  }

  protected override _deserialize(raw: unknown): LastCwdState | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined
    const o = raw as PersistedShape
    if (o.schemaVersion !== SCHEMA_VERSION) {
      this._logger.warn(`ignoring acp.lastSessionCwd with schemaVersion=${o.schemaVersion}`)
      return undefined
    }
    if (o.cwd !== undefined && typeof o.cwd !== 'string') return undefined
    if (o.authority !== undefined && typeof o.authority !== 'string') return undefined
    if (o.cwd === undefined) return {}
    return o.authority !== undefined ? { cwd: o.cwd, authority: o.authority } : { cwd: o.cwd }
  }

  protected override _onStateReplaced(_state: LastCwdState): void {
    // No observable mirror — consumers read via lastCwd() on demand.
  }
}

registerSingleton(IAcpLastSessionCwdService, AcpLastSessionCwdService, InstantiationType.Delayed)
