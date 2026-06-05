/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Diff-related built-in actions. `_workbench.openDiff` is an internal command
 *  (no command-palette entry) the extension host invokes to surface a diff it
 *  computed — e.g. the Git extension's "open changes". The host can't construct
 *  an EditorInput, so it ships the already-resolved text and we build the input.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorGroupsService,
  URI,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { DiffEditorInput } from '../services/editor/DiffEditorInput.js'

export interface OpenDiffPayload {
  readonly title: string
  /** Serialized `file:` URI naming the file under comparison (used for the label/language). */
  readonly originalUri: string
  /** Left-hand side content (e.g. the HEAD or staged version). */
  readonly original: string
  /** Right-hand side content (e.g. the working-tree version). */
  readonly modified: string
  /** When true the editor opens (or is promoted) as a permanent tab, ending preview state. */
  readonly pinned?: boolean
}

export class OpenDiffAction extends Action2 {
  static readonly ID = '_workbench.openDiff'

  constructor() {
    super({ id: OpenDiffAction.ID, title: 'Open Diff' })
  }

  override run(accessor: ServicesAccessor, payload: OpenDiffPayload): void {
    const groups = accessor.get(IEditorGroupsService)
    const group = groups.activeGroup
    const id = `diff:${URI.parse(payload.originalUri).toString()}`

    const pinned = payload.pinned ?? false

    // Reuse an already-open diff for the same file: refresh its content in place
    // and re-activate, instead of opening a duplicate.
    const existing = group.editors.find((e) => e.id === id)
    if (existing instanceof DiffEditorInput) {
      existing.update(payload.original, payload.modified)
      // Double-click (pinned=true) promotes a preview tab to permanent.
      group.openEditor(existing, { activate: true, pinned })
      return
    }

    const input = new DiffEditorInput(
      URI.parse(payload.originalUri),
      payload.original,
      payload.modified,
    )
    // Single-click uses the preview slot; double-click opens a permanent tab.
    group.openEditor(input, { activate: true, pinned })
  }
}
