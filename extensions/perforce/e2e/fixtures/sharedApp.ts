/*---------------------------------------------------------------------------------------------
 *  Shared-instance fixture for Perforce specs that don't need a fake p4 server —
 *  e.g. the Perforce Graph editor, a renderer Action2 that opens regardless of
 *  server reachability. Activates only the Perforce extension (P2 minimal set).
 *--------------------------------------------------------------------------------------------*/

import { createSharedAppTest, resolveEditorBuild } from '@universe-editor/e2e-harness'

const { appRoot, mainEntry } = resolveEditorBuild()

export const test = createSharedAppTest({
  appRoot,
  mainEntry,
  extensions: ['@universe-editor/perforce'],
})

export { expect } from '@universe-editor/e2e-harness'
