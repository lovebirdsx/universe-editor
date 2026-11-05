/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Process-wide ProcessLifecycleRegistry singleton (OS-level owner binding for local child
 *  process trees; mechanism in docs/development/process-lifecycle.md). Like
 *  processRoleRegistry it exists before DI/logging are up, so spawn sites import it
 *  directly and main startup calls initProcessLifecycle() once to wire the Windows
 *  Job Object addon and a logger.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import { app } from 'electron'
import { loadJobBackend, ProcessLifecycleRegistry } from '@universe-editor/node-services'
import type { ILogger } from '@universe-editor/platform'
import { resolveFromRepo } from '../../repoPaths.js'

export const processLifecycle = new ProcessLifecycleRegistry()

const ADDON_FILE = 'process_job.node'

/** Packaged: staged into resources by runtime-resources.mjs; dev: node-gyp output in the repo. */
export function resolveProcessJobAddonPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'process-job', ADDON_FILE)
    : resolveFromRepo(`packages/process-job/build/Release/${ADDON_FILE}`)
}

export function initProcessLifecycle(logger: ILogger): void {
  const backend = loadJobBackend(resolveProcessJobAddonPath(), { logger })
  processLifecycle.configure({ backend, logger })
  logger.info(`process lifecycle ready jobBackend=${backend !== undefined}`)
}
