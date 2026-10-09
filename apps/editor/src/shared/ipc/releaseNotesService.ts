/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Cross-process contract for release notes. The data is the compiled derivative of the
 *  Markdown sources in docs/release-notes/ (scripts/release/release-notes/compile.mjs),
 *  shipped inside the installer (electron-builder extraResources) and read by the main
 *  process. The renderer filters the version range it cares about and renders each
 *  version's `body` markdown on its own.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'

/** One released version. `title`/`summary` are empty for the migrated (legacy) archive. */
export interface IReleaseNote {
  readonly version: string
  /** ISO date (YYYY-MM-DD) of the tag, when the source carried one. */
  readonly date?: string
  /** Short headline shown in the version header and version lists. */
  readonly title: string
  /** One-sentence summary, used by the download page list. */
  readonly summary: string
  /** Version body markdown (starts at `##`; the version title is rendered by the consumer). */
  readonly body: string
}

export interface IReleaseNotesData {
  /** App version currently running (`getAppVersion()`). */
  readonly currentVersion: string
  /** Every released version the install knows about, newest first. */
  readonly notes: readonly IReleaseNote[]
}

export interface IReleaseNotesService {
  readonly _serviceBrand: undefined
  getReleaseNotes(): Promise<IReleaseNotesData>
}

export const IReleaseNotesService = createDecorator<IReleaseNotesService>('releaseNotesService')
