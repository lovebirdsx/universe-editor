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

/**
 * Built-in doc sets. `user` is the end-user guide (docs/user/), `extensionDev`
 * the extension-author guide (docs/extension-dev/). Each ships as its own
 * directory beside app.asar and is cached separately in the renderer.
 */
export type DocCategory = 'user' | 'extensionDev'

export const DOC_CATEGORIES: readonly DocCategory[] = ['user', 'extensionDev']

export interface IDocsService {
  readonly _serviceBrand: undefined
  /** Load every built-in document grouped by category and locale. Missing dirs degrade to empty maps. */
  getDocs(): Promise<Record<DocCategory, DocsByLocale>>
  /** Absolute path to a category's docs root (dev tree or packaged resources), for `#docs`-style context refs. */
  getDocsRoot(category: DocCategory): Promise<string>
}

export const IDocsService = createDecorator<IDocsService>('docsService')
