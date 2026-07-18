/*---------------------------------------------------------------------------------------------
 *  Cold-launch fixture for core specs that need the TypeScript language provider
 *  to set up their scenario (references-peek preview across .ts files). The peek
 *  widget under test is core UI — the typescript extension is only activated so
 *  real definitions/references resolve. Nothing else runs (P2 minimal set).
 *--------------------------------------------------------------------------------------------*/

import { createColdAppTest } from '@universe-editor/e2e-harness'
import { APP_ROOT, MAIN_ENTRY } from './electronApp.js'

export const test = createColdAppTest({
  appRoot: APP_ROOT,
  mainEntry: MAIN_ENTRY,
  extensions: ['@universe-editor/typescript'],
})

export { expect, closeApp } from '@universe-editor/e2e-harness'
