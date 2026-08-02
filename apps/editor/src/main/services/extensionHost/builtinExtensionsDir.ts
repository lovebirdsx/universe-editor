/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Single source of truth for the built-in extensions directory. Both the
 *  extension-host service (which scans it to activate built-ins) and the
 *  extension-management service (which lists built-ins for the Extensions UI so
 *  they can be enabled / disabled) must agree on this path, so it lives here.
 *
 *  Layout: repo `extensions/` in dev, `resources/extensions/` when packaged.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import { app } from 'electron'
import { resolveFromRepo } from '../../repoPaths.js'

/** Bundled built-in extensions tree, relative to the repo root in the dev tree. */
const EXTENSIONS_DEV = 'extensions'
/** Same tree under `resourcesPath` in a packaged build. */
const EXTENSIONS_PACKAGED = 'extensions'

/** `<repo>/extensions` in dev, `<resources>/extensions` when packaged. */
export function resolveBuiltinExtensionsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, EXTENSIONS_PACKAGED)
    : resolveFromRepo(EXTENSIONS_DEV)
}
