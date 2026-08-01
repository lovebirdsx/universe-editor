/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Single-truth normalization for --extension-development-path roots. Unlike
 *  builtinExtensionsDir / userExtensionsDir (which read process.env directly),
 *  the values themselves come from IEnvironmentMainService (cli is a repeatable
 *  flag — only the ConfigResolver machinery can collect it); this module only
 *  normalizes. Host scanning and extension-management listing share this, so it
 *  lives in one place.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'

/** Absolutize + normalize each dev extension root, preserving order. */
export function normalizeDevExtensionPaths(raw: readonly string[]): string[] {
  return raw.map((p) => path.resolve(p))
}
