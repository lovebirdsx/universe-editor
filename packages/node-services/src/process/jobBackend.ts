/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Loads the Windows Job Object addon (packages/process-job) by absolute path. The addon is
 *  an N-API binary shipped as a runtime resource (never bundled/asar-packed), so a missing,
 *  unloadable or off-platform addon is an expected, non-fatal condition: callers get
 *  `undefined` and the registry degrades to tree-kill + stdin-EOF watchdogs.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { ILogger } from '@universe-editor/platform'
import type { JobBackend } from './processLifecycle.js'

const requireFromHere = createRequire(import.meta.url)

const REQUIRED_EXPORTS: ReadonlyArray<keyof JobBackend> = [
  'createJob',
  'assign',
  'terminate',
  'close',
  'listPids',
]

export interface LoadJobBackendOptions {
  readonly logger?: ILogger
  readonly platform?: NodeJS.Platform
  /** Injectable for tests; defaults to `require(addonPath)`. */
  readonly load?: (addonPath: string) => unknown
}

export function loadJobBackend(
  addonPath: string,
  options: LoadJobBackendOptions = {},
): JobBackend | undefined {
  const platform = options.platform ?? process.platform
  const log = options.logger
  if (platform !== 'win32') return undefined
  if (process.env['UNIVERSE_DISABLE_PROCESS_JOB'] === '1') {
    log?.info('process job disabled by UNIVERSE_DISABLE_PROCESS_JOB=1')
    return undefined
  }
  if (!options.load && !existsSync(addonPath)) {
    log?.warn(`process job addon not found at ${addonPath} — falling back to tree-kill`)
    return undefined
  }
  try {
    const mod = (options.load ?? requireFromHere)(addonPath) as Partial<JobBackend> | undefined
    const missing = REQUIRED_EXPORTS.filter((name) => typeof mod?.[name] !== 'function')
    if (!mod || missing.length > 0) {
      log?.warn(`process job addon has an unexpected shape (missing: ${missing.join(',')})`)
      return undefined
    }
    log?.info(`process job addon loaded from ${addonPath}`)
    if (typeof mod.listProcesses !== 'function') {
      // Older addons keep full containment; only the orphan sweep needs the snapshot.
      log?.warn('process job addon has no listProcesses — orphan sweep disabled')
    }
    return mod as JobBackend
  } catch (err) {
    log?.warn(`process job addon failed to load: ${String(err)} — falling back to tree-kill`)
    return undefined
  }
}
