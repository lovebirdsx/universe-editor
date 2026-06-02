/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Cross-process contract for release notes. The data is generated at build time
 *  from git history (scripts/release/changelog.mjs), shipped inside the installer
 *  (electron-builder extraResources), and read by the main process. The renderer
 *  filters the version range it cares about and renders it as a markdown tab.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'

/** One group of changes within a version, keyed by commit type (feat/fix/…). */
export interface IReleaseNoteGroup {
  readonly type: string
  /** Localized heading, e.g. `新功能`. */
  readonly title: string
  readonly items: readonly string[]
}

/** Changes shipped in a single released version. */
export interface IReleaseNote {
  readonly version: string
  /** ISO date (YYYY-MM-DD) of the tag, when available. */
  readonly date?: string
  readonly groups: readonly IReleaseNoteGroup[]
}

export interface IReleaseNotesData {
  /** App version currently running (`app.getVersion()`). */
  readonly currentVersion: string
  /** All released versions, newest first. */
  readonly notes: readonly IReleaseNote[]
}

export interface IReleaseNotesService {
  readonly _serviceBrand: undefined
  getReleaseNotes(): Promise<IReleaseNotesData>
}

export const IReleaseNotesService = createDecorator<IReleaseNotesService>('releaseNotesService')
