/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Resolves the vendored typescript-language-server CLI + the bundled tsserver,
 *  injected into the trusted extension host's env (UNIVERSE_TSLS_CLI /
 *  UNIVERSE_TSLS_TSSERVER) so the `typescript` plugin can spawn the LSP server
 *  itself without touching any Electron API. This Electron-aware path resolution
 *  is the one piece that must stay in the main process.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'

/** CLI under the vendor dir, found by walking up from getAppPath in dev. */
const CLI_VENDOR_REL =
  'vendor/typescript-language-server/node_modules/typescript-language-server/lib/cli.mjs'
/** CLI relative to `process.resourcesPath` in a packaged build. */
const CLI_PACKAGED_REL =
  'typescript-language-server/node_modules/typescript-language-server/lib/cli.mjs'

/** tsserver.js sits beside the CLI's node_modules (…/node_modules/typescript/lib/tsserver.js). */
function tsserverFor(cli: string): string {
  return path.resolve(path.dirname(cli), '../../typescript/lib/tsserver.js')
}

/**
 * Locate the vendored CLI by walking up from `app.getAppPath()` (dev) or under
 * `process.resourcesPath` (packaged). The dev walk-up tolerates both `electron .`
 * (appPath = apps/editor) and the e2e `electron out/main/index.js` layout.
 */
export function resolveTsServerPaths(): { cli: string; tsserver: string } {
  if (app.isPackaged) {
    const cli = path.join(process.resourcesPath, CLI_PACKAGED_REL)
    return { cli, tsserver: tsserverFor(cli) }
  }
  let dir = app.getAppPath()
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, CLI_VENDOR_REL)
    if (existsSync(candidate)) return { cli: candidate, tsserver: tsserverFor(candidate) }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const cli = path.resolve(app.getAppPath(), '../..', CLI_VENDOR_REL)
  return { cli, tsserver: tsserverFor(cli) }
}
