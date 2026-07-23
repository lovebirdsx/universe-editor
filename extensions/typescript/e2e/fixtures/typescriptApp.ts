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
  // These specs assert vendored-TSLS/tsserver behavior (semantic-token recolor,
  // references CodeLens). Dev builds default to the Go native LSP
  // (typescript.server.implementation=native), whose semanticTokens support is
  // not yet on par — pin tsls so the suite tracks the server it was written
  // against. tsgo parity is covered separately by lspParityProbe.mjs.
  env: { UNIVERSE_TS_SERVER: 'tsls' },
})

export { expect, closeApp } from '@universe-editor/e2e-harness'
