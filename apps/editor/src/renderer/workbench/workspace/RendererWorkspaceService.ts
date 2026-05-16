/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side IWorkspaceService. Wraps the cross-process wire service with
 *  a synchronous-getter facade backed by event-driven local state.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  Emitter,
  type Event,
  type IRecentWorkspace,
  type IWorkspace,
  type IWorkspaceService,
  type IWorkspaceServiceWire,
  URI,
  type UriComponents,
} from '@universe-editor/platform'

function reviveWorkspace(raw: IWorkspace | null): IWorkspace | null {
  if (!raw) return null
  const folder =
    raw.folder instanceof URI ? raw.folder : (URI.revive(raw.folder as UriComponents) as URI)
  return { folder, name: raw.name }
}

function reviveRecent(raw: readonly IRecentWorkspace[]): readonly IRecentWorkspace[] {
  return raw.map((r) => ({
    folder: r.folder instanceof URI ? r.folder : (URI.revive(r.folder as UriComponents) as URI),
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

  constructor(private readonly _wire: IWorkspaceServiceWire) {
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
    void _wire.getCurrent().then((w) => {
      const revived = reviveWorkspace(w)
      if (revived !== this._current) {
        this._current = revived
        this._onDidChangeWorkspace.fire(revived)
      }
    })
    void _wire.getRecent().then((r) => {
      const revived = reviveRecent(r)
      if (revived.length > 0 || this._recent.length > 0) {
        this._recent = revived
        this._onDidChangeRecent.fire(revived)
      }
    })
  }

  get current(): IWorkspace | null {
    return this._current
  }

  get recent(): readonly IRecentWorkspace[] {
    return this._recent
  }

  openFolder(folder?: URI): Promise<void> {
    return this._wire.openFolder(folder)
  }

  closeFolder(): Promise<void> {
    return this._wire.closeFolder()
  }

  clearRecent(): Promise<void> {
    return this._wire.clearRecent()
  }
}
