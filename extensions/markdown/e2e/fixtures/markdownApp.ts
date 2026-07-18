/*---------------------------------------------------------------------------------------------
 *  Cold-launch fixture for Markdown extension specs. Activates only the Markdown
 *  extension (P2 minimal set) so the core suite never has to boot the Markdown
 *  language server. Each test gets a fresh Electron instance.
 *--------------------------------------------------------------------------------------------*/

import { createColdAppTest, resolveEditorBuild } from '@universe-editor/e2e-harness'

const { appRoot, mainEntry } = resolveEditorBuild()

export const test = createColdAppTest({
  appRoot,
  mainEntry,
  extensions: ['@universe-editor/markdown'],
})

export { expect, closeApp } from '@universe-editor/e2e-harness'
