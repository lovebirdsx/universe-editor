/*---------------------------------------------------------------------------------------------
 *  Cold-launch fixture for TypeScript extension specs. Activates only the
 *  TypeScript extension (P2 minimal set); the extension self-spawns its own
 *  tsserver, so the core suite never pays that cost. Fresh Electron per test.
 *--------------------------------------------------------------------------------------------*/

import { createColdAppTest, resolveEditorBuild } from '@universe-editor/e2e-harness'

const { appRoot, mainEntry } = resolveEditorBuild()

export const test = createColdAppTest({
  appRoot,
  mainEntry,
  extensions: ['@universe-editor/typescript'],
})

export { expect, closeApp } from '@universe-editor/e2e-harness'
