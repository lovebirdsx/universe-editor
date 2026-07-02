/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Allow-list bookkeeping for the universe-app protocol, kept free of any
 *  electron import so the path-boundary rules can be unit-tested in a plain node
 *  environment. The protocol handler (resourceProtocol.ts) enforces these.
 *
 *  Path identity (case policy, boundary containment) is delegated to the platform
 *  kernel — see [[path-comparison-convergence]] — never hand-rolled here.
 *--------------------------------------------------------------------------------------------*/

import { resolve } from 'node:path'
import {
  getPathComparisonKey,
  normalizePlatform,
  relativePathUnder,
} from '@universe-editor/platform'

const platform = normalizePlatform(process.platform)

// Allowed root directories, keyed by their platform-aware comparison key (so the
// same dir added twice under different casing dedupes) → the resolved abs path.
const allowedRoots = new Map<string, string>()

export function allowResourceRoots(dirPaths: readonly string[]): void {
  for (const dir of dirPaths) {
    if (!dir) continue
    const abs = resolve(dir)
    allowedRoots.set(getPathComparisonKey(abs, platform), abs)
  }
}

/** True when `filePath` sits inside (or is) one of the allowed roots. */
export function isPathAllowed(filePath: string): boolean {
  const abs = resolve(filePath)
  for (const root of allowedRoots.values()) {
    if (relativePathUnder(root, abs, platform) !== null) return true
  }
  return false
}

/** Test-only: drop all grants so cases don't leak into each other. */
export function clearResourceRoots(): void {
  allowedRoots.clear()
}
