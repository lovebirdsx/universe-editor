/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shows "what's new" after an upgrade (VSCode-style): on startup, compares the
 *  running version against the last version the user saw (persisted in GLOBAL
 *  storage). When it advanced, opens a markdown tab covering every version in the
 *  range. First install records the version silently — new users aren't prompted.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IEditorGroupsService,
  IStorageService,
  IWorkbenchContribution,
  StorageScope,
  localize,
} from '@universe-editor/platform'
import { IReleaseNotesService } from '../../shared/ipc/releaseNotesService.js'
import { ReleaseNotesInput } from '../services/editor/ReleaseNotesInput.js'
import {
  compareVersions,
  renderReleaseNotesMarkdown,
  selectNotesInRange,
} from '../services/releaseNotes/releaseNotes.js'

const LAST_VERSION_KEY = 'app.releaseNotes.lastVersion'

export class ReleaseNotesContribution extends Disposable implements IWorkbenchContribution {
  /** Resolves once the upgrade check has run — awaited by tests. */
  readonly whenReady: Promise<void>

  constructor(
    @IReleaseNotesService private readonly _releaseNotes: IReleaseNotesService,
    @IStorageService private readonly _storage: IStorageService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
  ) {
    super()
    this.whenReady = this._showIfUpgraded()
  }

  private async _showIfUpgraded(): Promise<void> {
    const { currentVersion, notes } = await this._releaseNotes.getReleaseNotes()
    const lastVersion = await this._storage.get<string>(LAST_VERSION_KEY, StorageScope.GLOBAL)

    if (!lastVersion) {
      await this._storage.set(LAST_VERSION_KEY, currentVersion, StorageScope.GLOBAL)
      return
    }
    if (compareVersions(currentVersion, lastVersion) <= 0) return

    const range = selectNotesInRange(notes, lastVersion, currentVersion)
    if (range.length > 0) {
      const input = new ReleaseNotesInput(
        renderReleaseNotesMarkdown(range),
        localize('releaseNotes.whatsNew', "What's New in {version}", { version: currentVersion }),
        'whatsNew',
      )
      this._groups.activeGroup.openEditor(input, { activate: true, pinned: true })
    }
    await this._storage.set(LAST_VERSION_KEY, currentVersion, StorageScope.GLOBAL)
  }
}
