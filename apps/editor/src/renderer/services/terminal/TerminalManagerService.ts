/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  TerminalManagerService — renderer-side view-model for the integrated terminal.
 *
 *  Holds the live terminal list + active id as observables (React reads via
 *  useObservable), bridges the cross-process ITerminalService proxy, and routes
 *  the single multiplexed `onData`/`onExit` streams to the right xterm instance
 *  by terminalId. Output that arrives before an xterm has attached (e.g. the
 *  shell's first prompt) is buffered per-terminal and flushed on attach.
 *
 *  Panel terminals are persisted to WORKSPACE storage so they survive restarts
 *  and workspace switches. Editor terminals are not persisted (they follow the
 *  editor group lifecycle).
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  createNamedLogger,
  Disposable,
  Emitter,
  IConfigurationService,
  InstantiationType,
  IStorageService,
  IWorkspaceService,
  observableValue,
  registerSingleton,
  StorageScope,
  toDisposable,
  ILoggerService,
  type Event,
  type IDisposable,
  type ILogger,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'
import { ITerminalService, type ITerminalCreatedInfo } from '../../../shared/ipc/terminalService.js'

export type TerminalTarget = 'panel' | 'editor'

export interface ITerminalNewSpec {
  readonly shell?: string
  readonly shellArgs?: readonly string[]
  readonly cwd?: string
  readonly target?: TerminalTarget
}

export interface ITerminalExitEvent {
  readonly id: string
  readonly exitCode: number
  readonly target: TerminalTarget
}

export interface ITerminalManagerService {
  readonly _serviceBrand: undefined

  /** All active terminals (panel + editor combined). */
  readonly terminals: IObservable<readonly ITerminalCreatedInfo[]>
  /** Panel-only terminals — consumed by TerminalView / TerminalViewToolbar. */
  readonly panelTerminals: IObservable<readonly ITerminalCreatedInfo[]>
  readonly activeTerminalId: IObservable<string | null>
  /** Fires when the active panel terminal's xterm should receive focus. */
  readonly onFocusRequest: Event<void>
  /** Fires when any terminal process exits, before the entry is removed. */
  readonly onDidTerminalExit: Event<ITerminalExitEvent>

  newTerminal(spec?: ITerminalNewSpec): Promise<string | null>
  closeTerminal(id: string): void
  setActiveTerminal(id: string): void
  /** Bind an xterm write callback; flushes buffered output. Dispose to detach. */
  attach(id: string, onData: (data: string) => void): IDisposable
  input(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  /** Trigger xterm focus on the active panel terminal. */
  focus(): void
  /** Load persisted panel terminals for the current workspace. */
  load(): Promise<void>
}

export const ITerminalManagerService =
  createDecorator<ITerminalManagerService>('terminalManagerService')

// ---------------------------------------------------------------------------

interface TermClient {
  buffer: string[]
  lineCount: number
  writer: ((data: string) => void) | undefined
  target: TerminalTarget
}

interface TermSpec {
  shell: string
  cwd?: string
  args?: readonly string[]
}

interface IPersistedTerminalState {
  schemaVersion: 1
  entries: Array<{ shell: string; cwd?: string; args?: readonly string[] }>
}

const STORAGE_KEY = 'terminal.panelState'
const SAVE_DEBOUNCE_MS = 200
const DEFAULT_SCROLLBACK = 5000
// Extra headroom kept before compacting the retained buffer, so we don't
// re-join on every newline once at the limit.
const TRIM_SLACK_LINES = 1024

function countNewlines(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++
  return n
}

export class TerminalManagerService extends Disposable implements ITerminalManagerService {
  declare readonly _serviceBrand: undefined

  private readonly _terminals: ISettableObservable<readonly ITerminalCreatedInfo[]> =
    observableValue<readonly ITerminalCreatedInfo[]>('terminal.terminals', [])
  private readonly _panelTerminals: ISettableObservable<readonly ITerminalCreatedInfo[]> =
    observableValue<readonly ITerminalCreatedInfo[]>('terminal.panelTerminals', [])
  private readonly _activeTerminalId: ISettableObservable<string | null> = observableValue<
    string | null
  >('terminal.activeId', null)

  readonly terminals: IObservable<readonly ITerminalCreatedInfo[]> = this._terminals
  readonly panelTerminals: IObservable<readonly ITerminalCreatedInfo[]> = this._panelTerminals
  readonly activeTerminalId: IObservable<string | null> = this._activeTerminalId

  private readonly _onFocusRequest = this._register(new Emitter<void>())
  readonly onFocusRequest: Event<void> = this._onFocusRequest.event

  private readonly _onDidTerminalExit = this._register(new Emitter<ITerminalExitEvent>())
  readonly onDidTerminalExit: Event<ITerminalExitEvent> = this._onDidTerminalExit.event

  private readonly _clients = new Map<string, TermClient>()
  private readonly _specs = new Map<string, TermSpec>()
  private readonly _logger: ILogger

  private _suspendPersist = false
  private _saveTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    @ITerminalService private readonly _terminal: ITerminalService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @ILoggerService loggerService: ILoggerService,
    @IStorageService private readonly _storage: IStorageService,
    @IConfigurationService private readonly _config: IConfigurationService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'terminal', name: 'Terminal' })
    this._register(this._terminal.onData(({ id, data }) => this._dispatch(id, data)))
    this._register(this._terminal.onExit(({ id, exitCode }) => this._onExit(id, exitCode)))
    this._register(
      this._storage.onDidChangeWorkspaceScope(() => {
        void this._reload()
      }),
    )
  }

  async newTerminal(spec?: ITerminalNewSpec): Promise<string | null> {
    const target: TerminalTarget = spec?.target ?? 'panel'

    const shell =
      spec?.shell || this._config.get<string>('terminal.integrated.shell') || undefined || undefined
    const args =
      spec?.shellArgs ??
      (this._config.get<readonly string[]>('terminal.integrated.shellArgs') || undefined) ??
      undefined
    const configCwd = this._config.get<string>('terminal.integrated.cwd') || undefined
    const cwd = spec?.cwd ?? configCwd ?? this._workspace.current?.folder?.fsPath

    const ipcSpec = {
      ...(shell ? { shell } : {}),
      ...(args && args.length > 0 ? { args } : {}),
      ...(cwd ? { cwd } : {}),
    }

    try {
      const info = await this._terminal.create(ipcSpec)
      this._clients.set(info.id, { buffer: [], lineCount: 0, writer: undefined, target })
      this._specs.set(info.id, {
        shell: info.shell,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(args !== undefined && args.length > 0 ? { args } : {}),
      })
      this._setAllTerminals([...this._terminals.get(), info])
      if (target === 'panel') {
        this._activeTerminalId.set(info.id, undefined)
      }
      this._schedulePersist()
      return info.id
    } catch (err) {
      this._logger.warn(`create failed: ${(err as Error).message}`)
      return null
    }
  }

  closeTerminal(id: string): void {
    void this._terminal.release(id)
    this._remove(id)
    this._schedulePersist()
  }

  setActiveTerminal(id: string): void {
    if (this._clients.has(id)) this._activeTerminalId.set(id, undefined)
  }

  attach(id: string, onData: (data: string) => void): IDisposable {
    const client = this._clients.get(id)
    if (!client) return toDisposable(() => {})
    client.writer = onData
    // Replay the full retained history so a freshly-created xterm (e.g. after
    // switching editors) restores its scrollback. The buffer is kept, not
    // cleared — it is the long-lived history copy.
    for (const chunk of client.buffer) onData(chunk)
    return toDisposable(() => {
      if (client.writer === onData) client.writer = undefined
    })
  }

  input(id: string, data: string): void {
    if (!this._clients.has(id)) return
    void this._terminal
      .input(id, data)
      .catch((err) => this._handleTerminalCallError('input', id, err))
  }

  resize(id: string, cols: number, rows: number): void {
    if (!this._clients.has(id)) return
    void this._terminal
      .resize(id, cols, rows)
      .catch((err) => this._handleTerminalCallError('resize', id, err))
  }

  focus(): void {
    this._onFocusRequest.fire()
  }

  async load(): Promise<void> {
    let data: IPersistedTerminalState | undefined
    try {
      data = await this._storage.get<IPersistedTerminalState>(STORAGE_KEY, StorageScope.WORKSPACE)
    } catch {
      return
    }
    if (!data || data.schemaVersion !== 1) return

    this._suspendPersist = true
    try {
      for (const entry of data.entries) {
        await this.newTerminal({
          ...(entry.shell ? { shell: entry.shell } : {}),
          ...(entry.cwd ? { cwd: entry.cwd } : {}),
          ...(entry.args && entry.args.length > 0 ? { shellArgs: entry.args } : {}),
          target: 'panel',
        })
      }
    } finally {
      this._suspendPersist = false
    }
  }

  async save(): Promise<void> {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = undefined
    }
    const entries = this._panelTerminals.get().map((t) => {
      const spec = this._specs.get(t.id)
      return {
        shell: spec?.shell ?? t.shell,
        ...(spec?.cwd ? { cwd: spec.cwd } : {}),
        ...(spec?.args && spec.args.length > 0 ? { args: spec.args } : {}),
      }
    })
    try {
      await this._storage.set(STORAGE_KEY, { schemaVersion: 1, entries }, StorageScope.WORKSPACE)
    } catch {
      // best-effort
    }
  }

  override dispose(): void {
    for (const id of this._clients.keys()) void this._terminal.release(id)
    this._clients.clear()
    this._specs.clear()
    super.dispose()
  }

  // -- internals ---------------------------------------------------------

  private _dispatch(id: string, data: string): void {
    const client = this._clients.get(id)
    if (!client) return
    client.buffer.push(data)
    client.lineCount += countNewlines(data)
    this._trim(client)
    if (client.writer) client.writer(data)
  }

  private _trim(client: TermClient): void {
    const maxLines =
      this._config.get<number>('terminal.integrated.scrollback') ?? DEFAULT_SCROLLBACK
    if (maxLines <= 0) return // unlimited
    // Compact lazily: only when comfortably over the limit, to avoid
    // re-joining the buffer on every chunk.
    if (client.lineCount <= maxLines + TRIM_SLACK_LINES) return
    const lines = client.buffer.join('').split('\n')
    const kept = lines.slice(-maxLines)
    const joined = kept.join('\n')
    client.buffer = joined ? [joined] : []
    client.lineCount = kept.length - 1
  }

  private _onExit(id: string, exitCode: number): void {
    const client = this._clients.get(id)
    if (client?.writer) client.writer(`\r\n[process exited with code ${exitCode}]\r\n`)
    this._onDidTerminalExit.fire({ id, exitCode, target: client?.target ?? 'panel' })
    this._remove(id)
    this._schedulePersist()
  }

  private _handleTerminalCallError(operation: 'input' | 'resize', id: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    if (message === `Terminal: unknown terminal ${id}`) return
    this._logger.warn(`${operation} failed id=${id}: ${message}`)
  }

  private _remove(id: string): void {
    if (!this._clients.delete(id)) return
    this._specs.delete(id)
    const next = this._terminals.get().filter((t) => t.id !== id)
    this._setAllTerminals(next)
    if (this._activeTerminalId.get() === id) {
      // activate the last remaining panel terminal, if any
      const lastPanel = [...this._panelTerminals.get()].pop()
      this._activeTerminalId.set(lastPanel?.id ?? null, undefined)
    }
  }

  private _setAllTerminals(next: readonly ITerminalCreatedInfo[]): void {
    this._terminals.set(next, undefined)
    this._panelTerminals.set(
      next.filter((t) => this._clients.get(t.id)?.target === 'panel'),
      undefined,
    )
  }

  private _schedulePersist(): void {
    if (this._suspendPersist) return
    if (this._saveTimer) clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(() => {
      this._saveTimer = undefined
      void this.save()
    }, SAVE_DEBOUNCE_MS)
  }

  private async _reload(): Promise<void> {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = undefined
    }
    this._suspendPersist = true
    try {
      // Close all panel terminals (editor terminals are managed by WorkspaceRestoreContribution)
      const panelIds = [...this._clients.entries()]
        .filter(([, c]) => c.target === 'panel')
        .map(([id]) => id)
      for (const id of panelIds) {
        void this._terminal.release(id)
        this._remove(id)
      }
    } finally {
      this._suspendPersist = false
    }
    await this.load()
  }
}

registerSingleton(ITerminalManagerService, TerminalManagerService, InstantiationType.Delayed)
