/*---------------------------------------------------------------------------------------------
 *  Scoped cold-launch fixture for the ACP agent orphan sweep (P1). Same app/extension
 *  baseline as electronApp, but the editor starts with a fast sweep interval so a spec
 *  does not have to wait the production 30s to observe a clean-up.
 *--------------------------------------------------------------------------------------------*/

import { createColdAppTest } from '@universe-editor/e2e-harness'
import { APP_ROOT, MAIN_ENTRY } from './electronApp.js'

export const test = createColdAppTest({
  appRoot: APP_ROOT,
  mainEntry: MAIN_ENTRY,
  extensions: [],
  env: { UNIVERSE_ORPHAN_SWEEP_MS: '400' },
})

export { expect, closeApp } from '@universe-editor/e2e-harness'
export type { E2EFixtures } from '@universe-editor/e2e-harness'
