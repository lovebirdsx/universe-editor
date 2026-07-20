/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side IWorkspaceService. Wraps the cross-process wire service with
 *  a synchronous-getter facade backed by event-driven local state.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  Emitter,
  NullLogger,
  type Event,
  type ILogger,
  type IRecentWorkspace,
  type ITelemetryService,
  type IWorkspace,
  type IWorkspaceService,
  type IWorkspaceServiceWire,
  URI,
} from '@universe-editor/platform'

function reviveWorkspace(raw: IWorkspace | null): IWorkspace | null {
  if (!raw) return null
  // `folder` arrives as a real URI: the IPC envelope revives $mid-stamped URIs
  // on the way across, so no manual revive is needed here.
  return { folder: raw.folder, name: raw.name }
}

function reviveRecent(raw: readonly IRecentWorkspace[]): readonly IRecentWorkspace[] {
  return raw.map((r) => ({
    folder: r.folder,
    name: r.name,
    lastOpened: r.lastOpened,
  }))
}

export class RendererWorkspaceService extends Disposable implements IWorkspaceService {
  declare readonly _serviceBrand: undefined

  private _current: IWorkspace | null = null
  private _recent: readonly IRecentWorkspace[] = []

  private readonly _onDidChangeWorkspace = this._register(new Emitter<IWorkspace | null>())
  readonly onDidChangeWorkspace: Event<IWorkspace | null> = this._onDidChangeWorkspace.event

  private readonly _onDidChangeRecent = this._register(new Emitter<readonly IRecentWorkspace[]>())
  readonly onDidChangeRecent: Event<readonly IRecentWorkspace[]> = this._onDidChangeRecent.event

  private _resolveReady!: () => void
  readonly whenReady: Promise<void> = new Promise<void>((resolve) => {
    this._resolveReady = resolve
  })

  constructor(
    private readonly _wire: IWorkspaceServiceWire,
    private readonly _telemetry?: ITelemetryService,
    private readonly _logger: ILogger = new NullLogger(),
  ) {
    super()
    this._register(
      _wire.onDidChangeWorkspace((w) => {
        this._current = reviveWorkspace(w)
        this._onDidChangeWorkspace.fire(this._current)
      }),
    )
    this._register(
      _wire.onDidChangeRecent((r) => {
        this._recent = reviveRecent(r)
        this._onDidChangeRecent.fire(this._recent)
      }),
    )
    // Pull initial state. Failures fall back to defaults; downstream listeners
    // simply see no initial event and stay with null / [].
    void _wire
      .getCurrent()
      .then((w) => {
        const revived = reviveWorkspace(w)
        if (revived !== this._current) {
          this._current = revived
          this._onDidChangeWorkspace.fire(revived)
        }
        this._logger.debug(`hydrate current=${revived?.folder.toString() ?? '<none>'}`)
      })
      .catch((err) => this._logger.warn('hydrate current failed', err))
      .finally(() => this._resolveReady())
    void _wire
      .getRecent()
      .then((r) => {
        const revived = reviveRecent(r)
        if (revived.length > 0 || this._recent.length > 0) {
          this._recent = revived
          this._onDidChangeRecent.fire(revived)
        }
        this._logger.debug(`hydrate recent=${revived.length}`)
      })
      .catch((err) => this._logger.warn('hydrate recent failed', err))
  }

  get current(): IWorkspace | null {
    return this._current
  }

  get recent(): readonly IRecentWorkspace[] {
    return this._recent
  }

  openFolder(folder?: URI): Promise<void> {
    this._telemetry?.publicLog('workspaceOpened')
    this._logger.info(`openFolder ${folder?.toString() ?? '<dialog>'}`)
    return this._wire.openFolder(folder)
  }

  closeFolder(): Promise<void> {
    this._logger.info(`closeFolder current=${this._current?.folder.toString() ?? '<none>'}`)
    return this._wire.closeFolder()
  }

  clearRecent(): Promise<void> {
    this._logger.info(`clearRecent count=${this._recent.length}`)
    return this._wire.clearRecent()
  }

  removeRecent(folder: URI): Promise<void> {
    this._logger.info(`removeRecent ${folder.toString()}`)
    return this._wire.removeRecent(folder)
  }
}
