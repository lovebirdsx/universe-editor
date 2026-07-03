/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Cross-process contract for the built-in user guide documents. The markdown
 *  source files live under docs/user/<locale>/ at the repo root; they ship
 *  beside app.asar (electron-builder extraResources) so they stay on disk as
 *  plain files instead of being inlined into the renderer bundle. The renderer
 *  reads the whole set once at startup and caches it (see docRegistry).
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'

/** All guide docs for one locale, keyed by docId (locale-relative path, no `.md`). */
export type DocsByLocale = Record<string, Record<string, string>>

export interface IDocsService {
  readonly _serviceBrand: undefined
  /** Load every guide document grouped by locale. Missing files degrade to an empty map. */
  getDocs(): Promise<DocsByLocale>
}

export const IDocsService = createDecorator<IDocsService>('docsService')
