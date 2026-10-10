/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Built-in Perforce Sync History editor input. A true singleton: one tab
 *  listing every get this install has run, whatever workspace is open (the
 *  history file lives under `globalStoragePath`). A constant URI is therefore
 *  the whole identity — no serialize/deserialize payload, and the id is stable
 *  across a window restore. See apps/editor/src/renderer/services/editor/CLAUDE.md.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI, localize } from '@universe-editor/platform'
import { perforceSyncHistoryViewState } from '../perforceSyncHistory/syncHistoryViewState.js'

const SYNC_HISTORY_URI = URI.from({ scheme: 'universe', path: '/perforceSyncHistory' })

export class PerforceSyncHistoryEditorInput extends EditorInput {
  static readonly TYPE_ID = 'perforceSyncHistory'

  /** Always the same instance: `deserialize` runs on restore, where nothing was
   *  persisted to rebuild — the one tab is addressed by its constant URI. */
  static deserialize(data: unknown): PerforceSyncHistoryEditorInput | null {
    // A payload would mean the id had drifted from the constant below; refuse it
    // rather than trusting state this input has no place to put.
    if (data !== undefined && data !== null) return null
    return new PerforceSyncHistoryEditorInput()
  }

  get typeId(): string {
    return PerforceSyncHistoryEditorInput.TYPE_ID
  }

  get resource(): URI {
    return SYNC_HISTORY_URI
  }

  getName(): string {
    return localize('perforceSyncHistory.title', 'Perforce Sync History')
  }

  /** Route focus into the run list (not the editor-group body) so arrow-key
   *  navigation works as soon as the tab opens — the page is a plain React tree
   *  with no Monaco registration. */
  override focus(): boolean {
    const focusRows = perforceSyncHistoryViewState.focusRows
    if (!focusRows) return false
    focusRows()
    return true
  }
}
