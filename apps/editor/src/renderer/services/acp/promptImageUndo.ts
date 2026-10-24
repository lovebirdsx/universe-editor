/*---------------------------------------------------------------------------------------------
 *  PromptImageUndo — undo/redo history for images attached to the prompt input.
 *
 *  Images live in React state, not in Monaco's text model, so they need their
 *  own history. The two histories are interleaved by `alternativeVersionId`:
 *  every entry records the model's alternative version at attach time, and is
 *  only consumable while that version is current. Typing after an attach bumps
 *  the version, so Ctrl+Z first lets Monaco undo the typing; once the undo walks
 *  back to the attach version, the image entry becomes available and the next
 *  Ctrl+Z removes the image. That keeps the visible order the chronological one
 *  without teaching Monaco about non-text edits.
 *--------------------------------------------------------------------------------------------*/

import type { PromptImage } from './promptImage.js'

interface ImageUndoEntry {
  readonly added: readonly PromptImage[]
  /** `model.getAlternativeVersionId()` at attach time; undefined pre-mount. */
  readonly altVersion: number | undefined
}

export interface PromptImageUndoState {
  readonly canUndo: boolean
  readonly canRedo: boolean
}

const MAX_ENTRIES = 50

export class PromptImageUndo {
  private readonly _undo: ImageUndoEntry[] = []
  private readonly _redo: ImageUndoEntry[] = []
  private _generation = 0

  /**
   * Bumped by `reset()`. A caller that starts an async attach captures this
   * before awaiting, so an attach that lands after the history was wiped (submit
   * / setText) can be recognised and skipped instead of leaving an entry whose
   * version can never match again.
   */
  get generation(): number {
    return this._generation
  }

  /** Record a batch of images attached in one gesture (paste, drop, URI drag). */
  recordAttach(
    added: readonly PromptImage[],
    altVersion: number | undefined,
    generation?: number,
  ): void {
    if (added.length === 0) return
    // A new attach is a new edit: whatever was undone can no longer be redone.
    this._redo.length = 0
    // Without a version (editor not mounted yet) or after a history reset the
    // entry would be permanently unconsumable and block the entries below it.
    if (altVersion === undefined) return
    if (generation !== undefined && generation !== this._generation) return
    this._undo.push({ added: [...added], altVersion })
    if (this._undo.length > MAX_ENTRIES) this._undo.shift()
  }

  canUndo(current: readonly PromptImage[], altVersion: number | undefined): boolean {
    return this._topUndo(current, altVersion) !== undefined
  }

  /** Remove the last attached batch. Returns the next image list, or null. */
  undo(
    current: readonly PromptImage[],
    altVersion: number | undefined,
  ): readonly PromptImage[] | null {
    const entry = this._topUndo(current, altVersion)
    if (entry === undefined) return null
    this._undo.pop()
    this._redo.push(entry)
    const removed = new Set(entry.added.map((image) => image.id))
    return current.filter((image) => !removed.has(image.id))
  }

  canRedo(current: readonly PromptImage[], altVersion: number | undefined): boolean {
    return this._topRedo(current, altVersion) !== undefined
  }

  /** Re-attach the last undone batch. Returns the next image list, or null. */
  redo(
    current: readonly PromptImage[],
    altVersion: number | undefined,
  ): readonly PromptImage[] | null {
    const entry = this._topRedo(current, altVersion)
    if (entry === undefined) return null
    this._redo.pop()
    this._undo.push(entry)
    const existing = new Set(current.map((image) => image.id))
    return [...current, ...entry.added.filter((image) => !existing.has(image.id))]
  }

  /**
   * Forget every entry touching `ids`. A chip removed by hand must not come
   * back on Ctrl+Z, and an undo entry that only re-adds part of a batch is
   * meaningless — drop the whole batch.
   */
  dropEntriesFor(ids: readonly string[]): void {
    if (ids.length === 0) return
    const dropped = new Set(ids)
    const keep = (entry: ImageUndoEntry): boolean =>
      !entry.added.some((image) => dropped.has(image.id))
    let write = 0
    for (const entry of this._undo) if (keep(entry)) this._undo[write++] = entry
    this._undo.length = write
    write = 0
    for (const entry of this._redo) if (keep(entry)) this._redo[write++] = entry
    this._redo.length = write
  }

  /** Any fresh edit invalidates the redo half of the history. */
  invalidateRedo(): void {
    this._redo.length = 0
  }

  reset(): void {
    this._undo.length = 0
    this._redo.length = 0
    this._generation++
  }

  state(current: readonly PromptImage[], altVersion: number | undefined): PromptImageUndoState {
    return {
      canUndo: this.canUndo(current, altVersion),
      canRedo: this.canRedo(current, altVersion),
    }
  }

  private _topUndo(
    current: readonly PromptImage[],
    altVersion: number | undefined,
  ): ImageUndoEntry | undefined {
    const entry = this._undo.at(-1)
    if (entry === undefined || altVersion === undefined) return undefined
    if (entry.altVersion !== altVersion) return undefined
    if (!entry.added.every((image) => current.some((candidate) => candidate.id === image.id))) {
      return undefined
    }
    return entry
  }

  private _topRedo(
    current: readonly PromptImage[],
    altVersion: number | undefined,
  ): ImageUndoEntry | undefined {
    const entry = this._redo.at(-1)
    if (entry === undefined || altVersion === undefined) return undefined
    if (entry.altVersion !== altVersion) return undefined
    const present = new Set(current.map((image) => image.id))
    if (entry.added.some((image) => present.has(image.id))) return undefined
    return entry
  }
}
