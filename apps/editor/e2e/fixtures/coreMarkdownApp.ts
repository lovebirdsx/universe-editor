/*---------------------------------------------------------------------------------------------
 *  Cold-launch fixture for the core peek-navigation spec, which follows a cross-
 *  file markdown link definition inside the peek widget. The peek keyboard path is
 *  core UI — the markdown extension is only activated so its LSP resolves the link
 *  definition. Nothing else runs (P2 minimal set).
 *--------------------------------------------------------------------------------------------*/

import { createColdAppTest } from '@universe-editor/e2e-harness'
import { APP_ROOT, MAIN_ENTRY } from './electronApp.js'

export const test = createColdAppTest({
  appRoot: APP_ROOT,
  mainEntry: MAIN_ENTRY,
  extensions: ['@universe-editor/markdown'],
})

export { expect, closeApp } from '@universe-editor/e2e-harness'
