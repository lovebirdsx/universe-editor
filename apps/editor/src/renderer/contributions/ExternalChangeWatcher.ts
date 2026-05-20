/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExternalChangeWatcher — bridge between IFileWatcherService events and the
 *  FileEditorInputs currently open in any editor group. Each batch is fanned
 *  out to matching inputs which decide (clean → silent reload, dirty → prompt)
 *  via `checkExternalChange`.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IDialogService,
  IEditorGroupsService,
  IFileWatcherService,
  type IWorkbenchContribution,
  URI,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'

export class ExternalChangeWatcher extends Disposable implements IWorkbenchContribution {
  constructor(
    @IFileWatcherService watcher: IFileWatcherService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IDialogService private readonly _dialog: IDialogService,
  ) {
    super()
    this._register(
      watcher.onDidChangeFiles((events) => {
        // Don't await — events run concurrently per group.
        void this._handle(events)
      }),
    )
  }

  private async _handle(events: readonly { resource: { path?: string } }[]): Promise<void> {
    if (events.length === 0) return
    const keys = new Set<string>()
    for (const ev of events) {
      const u = URI.revive(ev.resource as Parameters<typeof URI.revive>[0])
      if (u) keys.add(u.toString())
    }
    if (keys.size === 0) return

    const matches: FileEditorInput[] = []
    for (const group of this._groups.groups) {
      for (const editor of group.editors) {
        if (editor instanceof FileEditorInput && keys.has(editor.resource.toString())) {
          matches.push(editor)
        }
      }
    }
    if (matches.length === 0) return

    // De-dup by URI: a file can be open in multiple groups, but we only want
    // to prompt once per resource.
    const seen = new Set<string>()
    for (const input of matches) {
      const key = input.resource.toString()
      if (seen.has(key)) continue
      seen.add(key)
      try {
        await input.checkExternalChange(this._dialog)
      } catch {
        // Best-effort: a failure on one input must not stall the others.
      }
    }
  }
}
