/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Single source of truth for the user (external) extensions directory. Both the
 *  extension-host service (which scans it) and the extension-management service
 *  (which writes to it) must agree on this path, so it lives in one place.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import { app } from 'electron'

/**
 * `<userData>/extensions` — where user-installed extensions live.
 *
 * Honours a `UNIVERSE_USER_EXTENSIONS_DIR` env override so e2e can point the
 * host at a fixture directory holding an unpackaged extension (VSCode's
 * `--extensionDevelopmentPath` model: load a `dist/` + `package.json` straight
 * off disk, no vsix install, no host relaunch). Production never sets it, so it
 * falls back to the real user-data path.
 */
export function resolveUserExtensionsDir(): string {
  const override = process.env.UNIVERSE_USER_EXTENSIONS_DIR
  if (override) return override
  return path.join(app.getPath('userData'), 'extensions')
}
