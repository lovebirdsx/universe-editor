/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process draft registry: one entry per `windowId:localId`, published by
 *  either the owning renderer or a phone subscriber. The hub assigns the
 *  monotonic revision, so last-writer-wins needs no cross-device clock.
 *--------------------------------------------------------------------------------------------*/

import type { MobileBridgeDraft } from '../../../shared/ipc/mobileGatewayService.js'
import type { MobileDraftPayload, MobileDraftState } from '@universe-editor/mobile-protocol'

export interface DraftRegistrySetResult {
  readonly state: MobileDraftState | undefined
  /** False when the content did not change; callers should not broadcast. */
  readonly changed: boolean
}

export function isDraftEmpty(draft: MobileDraftState): boolean {
  return (
    draft.text === '' &&
    draft.images.length === 0 &&
    (draft.files?.length ?? 0) === 0 &&
    (draft.refs?.length ?? 0) === 0 &&
    (draft.contexts?.length ?? 0) === 0
  )
}

/** Drafts are only a convenience; a long-lived PC would otherwise keep one per session. */
export const MAX_DRAFT_ENTRIES = 32

export class MobileDraftRegistry {
  private readonly _entries = new Map<string, MobileDraftState>()
  private _revision = 0

  get(key: string): MobileDraftState | undefined {
    return this._entries.get(key)
  }

  delete(key: string): void {
    this._entries.delete(key)
  }

  deleteWindow(windowId: number): void {
    const prefix = `${windowId}:`
    for (const key of this._entries.keys()) {
      if (key.startsWith(prefix)) this._entries.delete(key)
    }
  }

  /** Store the renderer's projection; an absent draft clears the entry. */
  setFromRenderer(key: string, draft: MobileBridgeDraft | undefined): DraftRegistrySetResult {
    if (draft === undefined) {
      const previous = this._entries.get(key)
      if (previous === undefined) return { state: undefined, changed: false }
      // Keep the emptied state's source on the pc side; the hub broadcasts this
      // to subscribers, who must not treat the clear as a phone edit.
      const empty = this._stateFor({ text: '', images: [] }, 'pc', previous)
      this._entries.delete(key)
      return { state: empty, changed: true }
    }
    const previous = this._entries.get(key)
    if (previous !== undefined && contentKey(previous) === contentKey(draft)) {
      return { state: previous, changed: false }
    }
    const next = this._stateFor(draft, 'pc', previous)
    // Re-insert so Map iteration order stays least-recently-used first.
    this._entries.delete(key)
    this._entries.set(key, next)
    this._evictOldest(key)
    return { state: next, changed: true }
  }

  /**
   * Store a phone-authored update. Phones cannot author refs/contexts: refs
   * survive only while the text is unchanged (their ranges point into the old
   * buffer); contexts always survive.
   */
  setFromPhone(key: string, draft: MobileDraftPayload): DraftRegistrySetResult {
    const previous = this._entries.get(key)
    const source: MobileBridgeDraft = {
      text: draft.text,
      images: draft.images,
      ...(draft.files !== undefined ? { files: draft.files } : {}),
      ...(previous?.text === draft.text && previous.refs !== undefined
        ? { refs: previous.refs }
        : {}),
      ...(previous?.contexts !== undefined ? { contexts: previous.contexts } : {}),
    }
    if (previous !== undefined && contentKey(previous) === contentKey(source)) {
      return { state: previous, changed: false }
    }
    const next = this._stateFor(source, 'mobile', previous)
    this._entries.delete(key)
    this._entries.set(key, next)
    this._evictOldest(key)
    return { state: next, changed: true }
  }

  private _evictOldest(keep: string): void {
    if (this._entries.size <= MAX_DRAFT_ENTRIES) return
    for (const key of this._entries.keys()) {
      if (key === keep) continue
      this._entries.delete(key)
      if (this._entries.size <= MAX_DRAFT_ENTRIES) return
    }
  }

  private _stateFor(
    draft: MobileBridgeDraft,
    source: MobileDraftState['source'],
    previous: MobileDraftState | undefined,
  ): MobileDraftState {
    this._revision = Math.max(this._revision + 1, (previous?.revision ?? 0) + 1)
    return {
      text: draft.text,
      images: draft.images,
      ...(draft.files !== undefined ? { files: draft.files } : {}),
      ...(draft.refs !== undefined ? { refs: draft.refs } : {}),
      ...(draft.contexts !== undefined ? { contexts: draft.contexts } : {}),
      revision: this._revision,
      updatedAt: Date.now(),
      source,
    }
  }
}

function contentKey(
  draft: Pick<MobileDraftState, 'text' | 'images' | 'files' | 'refs' | 'contexts'>,
): string {
  return JSON.stringify([
    draft.text,
    draft.images,
    draft.files ?? [],
    draft.refs ?? [],
    draft.contexts ?? [],
  ])
}
