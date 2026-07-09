/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Single source of truth for the built-in extensions directory. Both the
 *  extension-host service (which scans it to activate built-ins) and the
 *  extension-management service (which lists built-ins for the Extensions UI so
 *  they can be enabled / disabled) must agree on this path, so it lives here.
 *
 *  Layout: repo `extensions/` in dev, `resources/extensions/` when packaged.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'

/** Bundled built-in extensions tree, relative to the repo root in the dev tree. */
const EXTENSIONS_DEV = 'extensions'
/** Same tree under `resourcesPath` in a packaged build. */
const EXTENSIONS_PACKAGED = 'extensions'

/**
 * Walk up from `app.getAppPath()` looking for a repo-relative path. Tolerates
 * both `electron .` (appPath = apps/editor) and the e2e `electron out/main/index.js`
 * layout (appPath points deeper), same approach as `resolveTsServerPaths`.
 */
function resolveFromRepo(relative: string): string {
  let dir = app.getAppPath()
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, relative)
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.resolve(app.getAppPath(), '../..', relative)
}

/** `<repo>/extensions` in dev, `<resources>/extensions` when packaged. */
export function resolveBuiltinExtensionsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, EXTENSIONS_PACKAGED)
    : resolveFromRepo(EXTENSIONS_DEV)
}
