/*---------------------------------------------------------------------------------------------
 *  Shared-instance fixture for the TextMate specs: grammars come from the
 *  built-in `@universe-editor/textmate-grammars` extension and the color theme
 *  from `@universe-editor/theme-defaults`, neither active in the P2 baseline.
 *--------------------------------------------------------------------------------------------*/

import { createSharedAppTest } from '@universe-editor/e2e-harness'
import { APP_ROOT, MAIN_ENTRY } from './electronApp.js'

export const test = createSharedAppTest({
  appRoot: APP_ROOT,
  mainEntry: MAIN_ENTRY,
  extensions: ['@universe-editor/theme-defaults', '@universe-editor/textmate-grammars'],
})

export { expect } from '@universe-editor/e2e-harness'
export type { SharedE2EFixtures } from '@universe-editor/e2e-harness'
