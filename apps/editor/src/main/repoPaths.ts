/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Dev-tree path resolution shared by main services that read repo-relative
 *  assets (vendor/ forks, extensions/, docs/, tsserver CLI, …).
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'

/**
 * Walk up from `app.getAppPath()` looking for a repo-relative path. Tolerates
 * both `electron .` (appPath = apps/editor) and the e2e / dev:run
 * `electron <entry>` layout (appPath points deeper). Falls back to the
 * historical `<appPath>/../../<relative>` guess when nothing exists, so
 * error messages still name a plausible location.
 *
 * Dev-tree only — packaged builds resolve under `process.resourcesPath`
 * instead; callers must branch on `app.isPackaged` before calling this.
 *
 * Red line: NEVER join repo-relative paths onto `app.getAppPath()` directly —
 * it silently breaks under `pnpm dev:run` (appPath = out-dev). Always go
 * through this helper.
 */
export function resolveFromRepo(relative: string): string {
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
