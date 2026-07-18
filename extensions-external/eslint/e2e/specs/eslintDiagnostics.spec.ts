/*---------------------------------------------------------------------------------------------
 *  Smoke: the real ESLint extension surfaces diagnostics for a workspace file.
 *
 *  Loads the extension off disk (no vsix install — see fixtures/eslintApp.ts) so
 *  this exercises the SHIPPED extension end-to-end: activation on a JS language,
 *  the standalone ESLint server subprocess resolving the workspace's own eslint,
 *  flat-config discovery, and diagnostics published back as Monaco markers.
 *
 *  @p1 (extension host + a spawned ESLint server subprocess; slower cold start).
 *--------------------------------------------------------------------------------------------*/

import { pathToFileURL } from 'node:url'
import * as fs from 'node:fs/promises'
import { test, expect, makeEslintWorkspace } from '../fixtures/eslintApp.js'

test.describe('@p1 eslint diagnostics', () => {
  test('reports a no-unused-vars diagnostic for a workspace file', async ({ workbench }) => {
    // Cold extension host + a spawned ESLint server that resolves + loads the
    // workspace's eslint; give it room on a loaded CI runner.
    test.slow()
    const { dir, filePath } = makeEslintWorkspace()
    const fileUri = pathToFileURL(filePath).toString()

    await workbench.waitForRestored()
    await workbench.openWorkspace(dir)

    // The extension declares `main` + untrustedWorkspaces.supported=false, so it's
    // gated off until the workspace is trusted. Trust it, as a user would.
    await workbench.runCommand('workbench.trust.grant')

    // Open the file so the extension activates (onLanguage:javascript) and lints it.
    await workbench.page.evaluate((p) => window.__E2E__!.openFileUri(p), filePath)

    // The server spawns, resolves eslint, loads the flat config, and publishes a
    // marker (owner `eslint`). Poll until the no-unused-vars diagnostic lands.
    await expect
      .poll(
        async () => {
          const markers = await workbench.page.evaluate(
            (u) => window.__E2E__!.getMarkers(u, 'eslint'),
            fileUri,
          )
          return markers.map((m) => m.message).join('\n')
        },
        { timeout: 20000 },
      )
      .toMatch(/no-unused-vars|unused/i)

    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
})
