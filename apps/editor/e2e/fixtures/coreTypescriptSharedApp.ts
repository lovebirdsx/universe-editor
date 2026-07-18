/*---------------------------------------------------------------------------------------------
 *  Shared-instance fixture for the core outline spec, which drives a cold tsserver
 *  across a file switch (the "outline empties on switch" regression). The outline
 *  view is core UI — the typescript extension is only activated so document
 *  symbols resolve. Nothing else runs (P2 minimal set).
 *--------------------------------------------------------------------------------------------*/

import { createSharedAppTest } from '@universe-editor/e2e-harness'
import { APP_ROOT, MAIN_ENTRY } from './electronApp.js'

export const test = createSharedAppTest({
  appRoot: APP_ROOT,
  mainEntry: MAIN_ENTRY,
  extensions: ['@universe-editor/typescript'],
})

export { expect } from '@universe-editor/e2e-harness'
