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
import { openInLockAwareGroup } from '../services/editor/openInLockAwareGroup.js'
import {
  compareVersions,
  renderReleaseNotesMarkdown,
  selectNotesInRange,
} from '../services/releaseNotes/releaseNotes.js'

const LAST_VERSION_KEY = 'app.releaseNotes.lastVersion'
const EXISTING_INSTALL_MARKER_KEYS = [
  'welcome.agentOnboarding.seen',
  'workbench.windowsState',
  'workbench.recentWorkspaces',
  'workbench.userSettings',
  'acp.chatLocation',
  'acp.agentDefaults',
  'acp.sessionHistory',
]

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
    let fromVersion = lastVersion

    if (!fromVersion) {
      if (await this._hasExistingInstallMarker()) {
        fromVersion = findPreviousReleaseVersion(notes, currentVersion)
      }
      if (!fromVersion) {
        await this._storage.set(LAST_VERSION_KEY, currentVersion, StorageScope.GLOBAL)
        return
      }
    }
    if (compareVersions(currentVersion, fromVersion) <= 0) return

    const range = selectNotesInRange(notes, fromVersion, currentVersion)
    if (range.length > 0) {
      const input = new ReleaseNotesInput(
        renderReleaseNotesMarkdown(range),
        localize('releaseNotes.whatsNew', "What's New in {version}", { version: currentVersion }),
        'whatsNew',
      )
      openInLockAwareGroup(this._groups, input, { activate: true, pinned: true })
    }
    await this._storage.set(LAST_VERSION_KEY, currentVersion, StorageScope.GLOBAL)
  }

  private async _hasExistingInstallMarker(): Promise<boolean> {
    for (const key of EXISTING_INSTALL_MARKER_KEYS) {
      const value = await this._storage.get<unknown>(key, StorageScope.GLOBAL)
      if (value !== undefined) return true
    }
    return false
  }
}

function findPreviousReleaseVersion(
  notes: readonly { readonly version: string }[],
  currentVersion: string,
): string | undefined {
  let previous: string | undefined
  for (const note of notes) {
    if (compareVersions(note.version, currentVersion) >= 0) continue
    if (!previous || compareVersions(note.version, previous) > 0) previous = note.version
  }
  return previous
}
