/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  mcpServerEnablementService — the per-server default on/off switch for MCP
 *  servers, persisted in IStorageService instead of settings.json.
 *
 *  Two scopes compose per server name (workspace wins):
 *    - GLOBAL    — user-level default, shared across all workspaces
 *    - WORKSPACE — override for the open folder only
 *  Effective state: `WORKSPACE record ?? GLOBAL record ?? enabled`.
 *  The switch applies to every definition source alike (settings layers,
 *  `.mcp.json`, extension contributions) — enablement is user state, fully
 *  decoupled from where the server is defined. A legacy `disabled: true`
 *  entry field in settings.json is simply inert (no migration).
 *
 *  Explicit `true` records are stored as-is (never normalized away): with a
 *  WORKSPACE-false override in place, flipping the user-level row back on
 *  must write a GLOBAL-true record — deleting the (absent) key would be a
 *  no-op and the row could never toggle.
 *
 *  Cold start mirrors LayoutService/PersistedStateBase: the WORKSPACE bucket
 *  is empty until main-side hydration fires `onDidChangeWorkspaceScope`, so
 *  the initial read waits for the first scope event or a short timeout (true
 *  empty-window case). Consumers (`AcpSessionService`) gate on `whenReady`.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  Disposable,
  Emitter,
  type Event,
  type ILogger,
  ILoggerService,
  IStorageService,
  IWorkspaceService,
  StorageScope,
} from '@universe-editor/platform'

const STORAGE_KEY = 'acp.mcpServerEnablement'
const INITIAL_LOAD_TIMEOUT_MS = 500

export interface IMcpServerEnablementService {
  readonly _serviceBrand: undefined

  /**
   * Cold-start barrier: GLOBAL has been read and the WORKSPACE bucket has
   * been hydrated (or the empty-window timeout elapsed). Reads before this
   * resolves see an empty workspace map (everything enabled).
   */
  readonly whenReady: Promise<void>

  /** Fires after initial load, after `setEnabled`, and after a workspace swap re-read. */
  readonly onDidChange: Event<void>

  /** Effective default for new sessions: WORKSPACE override ?? GLOBAL override ?? true. */
  isEnabled(name: string): boolean

  /** The explicit override recorded at one scope, or undefined when unset. */
  getOverride(name: string, scope: StorageScope): boolean | undefined

  /**
   * Record an explicit override at the given scope. The in-memory cache flips
   * synchronously (so a session created right after a toggle sees it) and the
   * record is persisted asynchronously. Writing WORKSPACE without an open
   * workspace is a no-op (logged).
   */
  setEnabled(name: string, enabled: boolean, scope: StorageScope): Promise<void>

  /**
   * Drop the override at the given scope, returning the name to inheritance
   * (workspace) or to the default-enabled state (global). No-op when no
   * override is recorded.
   */
  removeOverride(name: string, scope: StorageScope): Promise<void>
}

export const IMcpServerEnablementService = createDecorator<IMcpServerEnablementService>(
  'mcpServerEnablementService',
)

export class McpServerEnablementService extends Disposable implements IMcpServerEnablementService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChange = this._register(new Emitter<void>())
  readonly onDidChange: Event<void> = this._onDidChange.event

  readonly whenReady: Promise<void>

  private readonly _logger: ILogger
  private _global: Record<string, boolean> = {}
  private _workspace: Record<string, boolean> = {}
  private _initialLoadDone = false

  constructor(
    @IStorageService private readonly _storage: IStorageService,
    @IWorkspaceService private readonly _workspaceService: IWorkspaceService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService.createLogger({
      id: 'acp.mcpServerEnablement',
      name: 'MCP Server Enablement',
    })
    this.whenReady = this._initialize()
    // Only genuine runtime swaps reload here; the cold-start event is consumed
    // by _initialize()'s own settle (same discipline as LayoutService).
    this._register(
      this._storage.onDidChangeWorkspaceScope(() => {
        if (!this._initialLoadDone) return
        void this._reloadWorkspace()
      }),
    )
  }

  isEnabled(name: string): boolean {
    return this._workspace[name] ?? this._global[name] ?? true
  }

  getOverride(name: string, scope: StorageScope): boolean | undefined {
    return (scope === StorageScope.WORKSPACE ? this._workspace : this._global)[name]
  }

  setEnabled(name: string, enabled: boolean, scope: StorageScope): Promise<void> {
    if (scope === StorageScope.WORKSPACE && !this._workspaceService.current) {
      this._logger.warn(`setEnabled(${name}) at WORKSPACE scope without an open workspace, ignored`)
      return Promise.resolve()
    }
    const current = scope === StorageScope.WORKSPACE ? this._workspace : this._global
    if (current[name] === enabled) return Promise.resolve()
    const next = { ...current, [name]: enabled }
    if (scope === StorageScope.WORKSPACE) this._workspace = next
    else this._global = next
    this._onDidChange.fire()
    return this._persist(scope)
  }

  removeOverride(name: string, scope: StorageScope): Promise<void> {
    const current = scope === StorageScope.WORKSPACE ? this._workspace : this._global
    if (!(name in current)) return Promise.resolve()
    const next = { ...current }
    delete next[name]
    if (scope === StorageScope.WORKSPACE) this._workspace = next
    else this._global = next
    this._onDidChange.fire()
    return this._persist(scope)
  }

  private async _initialize(): Promise<void> {
    this._global = sanitizeEnablementRecord(await this._read(StorageScope.GLOBAL))
    if (!this._workspaceService.current) {
      await new Promise<void>((resolve) => {
        let resolved = false
        const settle = () => {
          if (resolved) return
          resolved = true
          subscription.dispose()
          clearTimeout(timer)
          resolve()
        }
        const subscription = this._register(this._storage.onDidChangeWorkspaceScope(settle))
        const timer = setTimeout(settle, INITIAL_LOAD_TIMEOUT_MS)
      })
    }
    if (this._workspaceService.current) {
      this._workspace = sanitizeEnablementRecord(await this._read(StorageScope.WORKSPACE))
    }
    this._initialLoadDone = true
    this._onDidChange.fire()
  }

  private async _reloadWorkspace(): Promise<void> {
    this._workspace = this._workspaceService.current
      ? sanitizeEnablementRecord(await this._read(StorageScope.WORKSPACE))
      : {}
    this._onDidChange.fire()
  }

  private async _read(scope: StorageScope): Promise<unknown> {
    try {
      return await this._storage.get(STORAGE_KEY, scope)
    } catch (err) {
      this._logger.warn(
        `failed to read ${STORAGE_KEY} (${StorageScope[scope]}): ${(err as Error).message}`,
      )
      return undefined
    }
  }

  private async _persist(scope: StorageScope): Promise<void> {
    try {
      await this._storage.set(
        STORAGE_KEY,
        scope === StorageScope.WORKSPACE ? this._workspace : this._global,
        scope,
      )
    } catch (err) {
      this._logger.warn(
        `failed to persist ${STORAGE_KEY} (${StorageScope[scope]}): ${(err as Error).message}`,
      )
    }
  }
}

/** Drop non-boolean values defensively; a broken record degrades to "all default". */
function sanitizeEnablementRecord(raw: unknown): Record<string, boolean> {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, boolean> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'boolean') out[name] = value
  }
  return out
}
