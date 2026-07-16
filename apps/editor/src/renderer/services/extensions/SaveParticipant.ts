/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SaveParticipant — a static registry that lets code outside the editor input
 *  (notably the extension host, via `workspace.onWillSaveTextDocument`) mutate a
 *  document just before it is written to disk.
 *
 *  FileEditorInput.save() has no DI access to the extension host client, and
 *  SaveAll can save models that have no live editor — so this mirrors the
 *  PendingDocumentSync / FileEditorRegistry pattern: a module-level singleton the
 *  input calls, and a workbench contribution registers the actual participant
 *  onto. Participants run in registration order; each is isolated (a throw is
 *  swallowed) so a broken participant never blocks the save.
 *--------------------------------------------------------------------------------------------*/

import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'

/** Why a save is happening. Matches the extension API's `TextDocumentSaveReason`
 *  and the wire `WillSaveReason` (1 = manual, 2 = after delay, 3 = focus out). */
export type SaveReason = 1 | 2 | 3

/** A participant mutates `model` in place before the save reads its value. It
 *  should apply its own edits (as its own undo step) and resolve when done. */
export type SaveParticipantFn = (
  model: monaco.editor.ITextModel,
  reason: SaveReason,
) => Promise<void>

class SaveParticipantImpl {
  private readonly _participants = new Set<SaveParticipantFn>()

  register(participant: SaveParticipantFn): { dispose: () => void } {
    this._participants.add(participant)
    return { dispose: () => this._participants.delete(participant) }
  }

  /** Run every participant against `model` in registration order. Never throws —
   *  a participant that rejects is logged and skipped so the save proceeds. */
  async participate(model: monaco.editor.ITextModel, reason: SaveReason): Promise<void> {
    if (this._participants.size === 0) return
    for (const participant of this._participants) {
      if (model.isDisposed()) return
      try {
        await participant(model, reason)
      } catch (err) {
        console.error('[save-participant] participant failed:', err)
      }
    }
  }
}

export const SaveParticipant = new SaveParticipantImpl()
