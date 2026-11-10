/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Routes a workspace's dirty check to the local git service or, for an open
 *  remote window, to that window's renderer SCM projection.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '@universe-editor/platform'
import type { IMobileBridgeService } from '../../../shared/ipc/mobileGatewayService.js'
import type { MobileGatewayHostWorkspace } from './mobileGatewayHub.js'

export const WORKSPACE_GIT_BRIDGE_TIMEOUT_MS = 1500

export type WorkspaceGitDirtyProbe = (
  workspace: MobileGatewayHostWorkspace,
  bridge: IMobileBridgeService | undefined,
  signal: AbortSignal,
) => Promise<boolean | undefined>

export interface WorkspaceGitDirtyProbeDeps {
  readonly isDirty: (root: string, signal?: AbortSignal) => Promise<boolean | undefined>
}

/**
 * `file:` workspaces (including UNC) are probed locally in main; other schemes
 * only work through an open window's renderer (the git extension lives in the
 * remote extension host). A recent-only remote workspace stays unknown.
 */
export function createWorkspaceGitDirtyProbe(
  deps: WorkspaceGitDirtyProbeDeps,
): WorkspaceGitDirtyProbe {
  return async (workspace, bridge, signal) => {
    try {
      const folder = URI.parse(workspace.folder)
      if (folder.scheme === '') return undefined
      if (folder.scheme === 'file') return await deps.isDirty(folder.fsPath, signal)
      if (bridge === undefined) return undefined
      return await raceBridgeProbe(bridge, signal)
    } catch {
      return undefined
    }
  }
}

function raceBridgeProbe(
  bridge: IMobileBridgeService,
  signal: AbortSignal,
): Promise<boolean | undefined> {
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise<boolean | undefined>((resolve) => {
    let settled = false
    const onAbort = (): void => finish(undefined)
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    const finish = (value: boolean | undefined): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const timer = setTimeout(() => finish(undefined), WORKSPACE_GIT_BRIDGE_TIMEOUT_MS)
    signal.addEventListener('abort', onAbort, { once: true })
    void bridge.getWorkspaceGitDirty().then(finish, () => finish(undefined))
  })
}
