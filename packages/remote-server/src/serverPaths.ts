/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Single source of truth for the daemon data-dir derived paths. Both the
 *  extension-host connection (resolveServerEnv) and the extension-management
 *  service resolve these from the same functions so the two can never drift.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'

/** User-installed extensions directory: `<dataDir>/user-extensions`. */
export function resolveUserExtensionsDir(dataDir: string): string {
  return path.join(dataDir, 'user-extensions')
}

/** Per-extension global storage: `<dataDir>/data/extensionGlobalStorage`. */
export function resolveExtensionGlobalStorageDir(dataDir: string): string {
  return path.join(dataDir, 'data', 'extensionGlobalStorage')
}
