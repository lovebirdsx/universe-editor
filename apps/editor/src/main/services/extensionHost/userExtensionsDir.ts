/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Single source of truth for the user (external) extensions directory. Both the
 *  extension-host service (which scans it) and the extension-management service
 *  (which writes to it) must agree on this path, so it lives in one place.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import { app } from 'electron'

/** `<userData>/extensions` — where user-installed extensions live. */
export function resolveUserExtensionsDir(): string {
  return path.join(app.getPath('userData'), 'extensions')
}
