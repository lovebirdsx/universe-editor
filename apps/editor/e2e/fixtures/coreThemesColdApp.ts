/*---------------------------------------------------------------------------------------------
 *  Cold-launch fixture for the icon-theme specs: asserting explorer protocol
 *  classes needs a real workspace, and `workspaceSeeder` only works on the
 *  cold-launch fixture (per-test Electron + per-test workspace folder).
 *  Activates the built-in theme-defaults extension that contributes the
 *  universe-material file icon theme.
 *--------------------------------------------------------------------------------------------*/

import { createColdAppTest } from '@universe-editor/e2e-harness'
import { APP_ROOT, MAIN_ENTRY } from './electronApp.js'

export const test = createColdAppTest({
  appRoot: APP_ROOT,
  mainEntry: MAIN_ENTRY,
  extensions: ['@universe-editor/theme-defaults'],
})

export { expect } from '@universe-editor/e2e-harness'
