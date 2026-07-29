/*---------------------------------------------------------------------------------------------
 *  Shared-instance fixture for the theme specs: the color themes under test are
 *  contributed by the built-in `@universe-editor/theme-defaults` extension, which
 *  the P2 empty baseline does not activate.
 *--------------------------------------------------------------------------------------------*/

import { createSharedAppTest } from '@universe-editor/e2e-harness'
import { APP_ROOT, MAIN_ENTRY } from './electronApp.js'

export const test = createSharedAppTest({
  appRoot: APP_ROOT,
  mainEntry: MAIN_ENTRY,
  extensions: ['@universe-editor/theme-defaults'],
})

export { expect } from '@universe-editor/e2e-harness'
export type { SharedE2EFixtures } from '@universe-editor/e2e-harness'
