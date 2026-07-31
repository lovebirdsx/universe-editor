/*---------------------------------------------------------------------------------------------
 *  Shared-instance fixture for the ported VSCode theme specs: Monokai is
 *  contributed by the built-in `@universe-editor/theme-monokai` extension,
 *  Dark Modern by `@universe-editor/theme-defaults`.
 *--------------------------------------------------------------------------------------------*/

import { createSharedAppTest } from '@universe-editor/e2e-harness'
import { APP_ROOT, MAIN_ENTRY } from './electronApp.js'

export const test = createSharedAppTest({
  appRoot: APP_ROOT,
  mainEntry: MAIN_ENTRY,
  extensions: ['@universe-editor/theme-defaults', '@universe-editor/theme-monokai'],
})

export { expect } from '@universe-editor/e2e-harness'
export type { SharedE2EFixtures } from '@universe-editor/e2e-harness'
