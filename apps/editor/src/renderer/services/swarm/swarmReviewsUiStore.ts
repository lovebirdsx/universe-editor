/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  swarmReviewsUiStore — renderer-side, persisted UI state for the Swarm Reviews
 *  sidebar: which groups are collapsed and the free-text keyword filter. Unlike
 *  the list filter settings (author set / approvable-only / hide-approved, which
 *  live in settings.json under `perforce.swarm.*`), these are transient view
 *  affordances persisted to IStorageService, not user configuration.
 *
 *  Persisted GLOBAL (Swarm reviews are a server-level resource, unrelated to the
 *  local workspace). Module-level singleton with a never-disposed Emitter (see
 *  memory `strictmode-useref-emitter-dispose-dev-only`) so it outlives any single
 *  mounted view. Mirrors swarmIgnoreStore's attach/isReady contract so the
 *  contribution can hydrate it at app start and the view's first render already
 *  reflects the saved collapse / keyword state.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, StorageScope, type Event, type IStorageService } from '@universe-editor/platform'

export type SwarmReviewsGroupKey = 'needsAction' | 'ignored' | 'authored'

const COLLAPSED_KEY = 'swarm.reviewsView.collapsed'
const KEYWORD_KEY = 'swarm.reviewsView.keyword'

const GROUP_KEYS: SwarmReviewsGroupKey[] = ['needsAction', 'ignored', 'authored']

export type SwarmReviewsCollapsedState = Record<SwarmReviewsGroupKey, boolean>

function defaultCollapsed(): SwarmReviewsCollapsedState {
  return { needsAction: false, ignored: false, authored: false }
}

class SwarmReviewsUiStore {
  private _storage: IStorageService | undefined
  private _collapsed: SwarmReviewsCollapsedState = defaultCollapsed()
  private _keyword = ''
  private readonly _onDidChange = new Emitter<void>()
  private _ready: Promise<void> | undefined
  private _isReady = false

  /** Fires after the persisted UI state changed (hydrate / collapse / keyword). */
  readonly onDidChange: Event<void> = this._onDidChange.event

  /** Bind the storage backend and load the persisted state. Idempotent: repeated
   *  calls (contribution + view) reuse the first load. */
  attach(storage: IStorageService): Promise<void> {
    if (this._ready) return this._ready
    this._storage = storage
    this._ready = (async () => {
      const [collapsed, keyword] = await Promise.all([
        storage.get<Partial<SwarmReviewsCollapsedState>>(COLLAPSED_KEY, StorageScope.GLOBAL),
        storage.get<string>(KEYWORD_KEY, StorageScope.GLOBAL),
      ])
      if (collapsed && typeof collapsed === 'object') {
        for (const key of GROUP_KEYS) {
          if (typeof collapsed[key] === 'boolean') this._collapsed[key] = collapsed[key]
        }
      }
      if (typeof keyword === 'string') this._keyword = keyword
      this._isReady = true
      this._onDidChange.fire()
    })()
    return this._ready
  }

  /** Synchronously true once the persisted state has finished loading. */
  get isReady(): boolean {
    return this._isReady
  }

  get collapsed(): SwarmReviewsCollapsedState {
    return this._collapsed
  }

  get keyword(): string {
    return this._keyword
  }

  setCollapsed(key: SwarmReviewsGroupKey, collapsed: boolean): void {
    if (this._collapsed[key] === collapsed) return
    this._collapsed = { ...this._collapsed, [key]: collapsed }
    void this._storage?.set(COLLAPSED_KEY, this._collapsed, StorageScope.GLOBAL)
    this._onDidChange.fire()
  }

  setKeyword(keyword: string): void {
    if (this._keyword === keyword) return
    this._keyword = keyword
    void this._storage?.set(KEYWORD_KEY, keyword, StorageScope.GLOBAL)
    this._onDidChange.fire()
  }
}

export const swarmReviewsUiStore = new SwarmReviewsUiStore()
