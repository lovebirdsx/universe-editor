/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  swarmIgnoreStore — renderer-side, persisted set of "ignored" Swarm reviews.
 *  Ignoring a review moves it out of "Needs My Action" into a dedicated IGNORED
 *  group; unignoring restores it. This is a pure client concept (no Swarm API,
 *  no host round-trip): the dashboard still returns the review, we just re-bucket
 *  it in the renderer.
 *
 *  Persisted GLOBAL (Swarm reviews are a server-level resource, unrelated to the
 *  local workspace) via IStorageService. Alongside the id set we keep a small
 *  metadata snapshot per review so the IGNORED group can render (and offer
 *  unignore) even when a later dashboard load no longer returns that review — e.g.
 *  its author dropped out of the needsActionAuthors filter.
 *
 *  Module-level singleton with a never-disposed Emitter (see memory
 *  `strictmode-useref-emitter-dispose-dev-only`): it outlives any single mounted
 *  component so the sidebar view and a review detail tab share one state and both
 *  react to an ignore/unignore taken in the other.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, StorageScope, type Event, type IStorageService } from '@universe-editor/platform'
import type { SwarmReviewDto } from '@universe-editor/extensions-common'

const IGNORED_IDS_KEY = 'swarm.ignoredReviews'
const IGNORED_META_KEY = 'swarm.ignoredReviewMeta'

class SwarmIgnoreStore {
  private _storage: IStorageService | undefined
  private readonly _ids = new Set<string>()
  private readonly _meta = new Map<string, SwarmReviewDto>()
  private readonly _onDidChange = new Emitter<void>()
  private _ready: Promise<void> | undefined
  private _isReady = false

  /** Fires after the ignored set changed (ignore / unignore / initial load). */
  readonly onDidChange: Event<void> = this._onDidChange.event

  /** Bind the storage backend and load the persisted set. Idempotent: repeated
   *  calls (view + editor both mount) reuse the first load. */
  attach(storage: IStorageService): Promise<void> {
    if (this._ready) return this._ready
    this._storage = storage
    this._ready = (async () => {
      const [ids, meta] = await Promise.all([
        storage.get<string[]>(IGNORED_IDS_KEY, StorageScope.GLOBAL),
        storage.get<Record<string, SwarmReviewDto>>(IGNORED_META_KEY, StorageScope.GLOBAL),
      ])
      if (Array.isArray(ids)) for (const id of ids) this._ids.add(id)
      if (meta && typeof meta === 'object') {
        for (const [id, dto] of Object.entries(meta)) if (dto) this._meta.set(id, dto)
      }
      this._isReady = true
      this._onDidChange.fire()
    })()
    return this._ready
  }

  /** Resolves once the persisted set is loaded (no-op if never attached). */
  get whenReady(): Promise<void> {
    return this._ready ?? Promise.resolve()
  }

  /** Synchronously true once the persisted set has finished loading. Lets the
   *  view gate its first render so an ignored review never flashes in "Needs My
   *  Action" before hydration reclassifies it. */
  get isReady(): boolean {
    return this._isReady
  }

  isIgnored(reviewId: string): boolean {
    return this._ids.has(reviewId)
  }

  /** Ignored review ids (insertion order). */
  list(): string[] {
    return [...this._ids]
  }

  /** The snapshot captured when a review was ignored — used to render the IGNORED
   *  group when the live dashboard no longer returns the review. */
  getMeta(reviewId: string): SwarmReviewDto | undefined {
    return this._meta.get(reviewId)
  }

  ignore(review: SwarmReviewDto): void {
    if (this._ids.has(review.id)) return
    this._ids.add(review.id)
    this._meta.set(review.id, review)
    this._persist()
    this._onDidChange.fire()
  }

  unignore(reviewId: string): void {
    if (!this._ids.delete(reviewId)) return
    this._meta.delete(reviewId)
    this._persist()
    this._onDidChange.fire()
  }

  private _persist(): void {
    const storage = this._storage
    if (!storage) return
    const meta: Record<string, SwarmReviewDto> = {}
    for (const [id, dto] of this._meta) meta[id] = dto
    void storage.set(IGNORED_IDS_KEY, [...this._ids], StorageScope.GLOBAL)
    void storage.set(IGNORED_META_KEY, meta, StorageScope.GLOBAL)
  }
}

export const swarmIgnoreStore = new SwarmIgnoreStore()

/**
 * Split a review list into the still-actionable set and the ignored set, by id.
 * Pure so the view's grouping is unit-testable without React or storage.
 */
export function splitIgnored(
  reviews: readonly SwarmReviewDto[],
  ignoredIds: ReadonlySet<string>,
): { active: SwarmReviewDto[]; ignored: SwarmReviewDto[] } {
  const active: SwarmReviewDto[] = []
  const ignored: SwarmReviewDto[] = []
  for (const review of reviews) {
    if (ignoredIds.has(review.id)) ignored.push(review)
    else active.push(review)
  }
  return { active, ignored }
}
