/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process workspace trust probe. The trusted-folder list is written by the
 *  renderer's WorkspaceTrustManagementService into the application-singleton
 *  state.json, so main can answer "is this folder trusted" without a window. Used
 *  before running a poll command, which executes shell code with the user's rights.
 *--------------------------------------------------------------------------------------------*/

import {
  normalizePlatform,
  relativePathUnder,
  URI,
  WORKSPACE_TRUST_STORAGE_KEY,
  type ILogger,
  type UriComponents,
} from '@universe-editor/platform'
import type { Storage } from '../../storage.js'

interface StoredTrustInfo {
  readonly uriTrustInfo?: readonly { readonly uri: UriComponents; readonly trusted?: boolean }[]
}

export interface WorkspaceTrustProbeOptions {
  readonly storage: Pick<Storage, 'get'>
  readonly logger: ILogger
}

/**
 * Mirrors `WorkspaceTrustManagementService`: a folder is trusted when it equals or
 * nests under a stored trusted folder (only `trusted: true` entries are persisted).
 * A read failure is treated as "untrusted" — the caller skips the shell command.
 */
export function createWorkspaceTrustProbe(
  options: WorkspaceTrustProbeOptions,
): (workspace: string) => Promise<boolean> {
  const platform = normalizePlatform(process.platform)
  return async (workspace: string): Promise<boolean> => {
    let stored: StoredTrustInfo | undefined
    try {
      stored = await options.storage.get<StoredTrustInfo>(WORKSPACE_TRUST_STORAGE_KEY)
    } catch (err) {
      options.logger.warn(`cannot read the trusted-folder list: ${describeError(err)}`)
      return false
    }
    for (const info of stored?.uriTrustInfo ?? []) {
      if (info.trusted !== true) continue
      const uri = URI.revive(info.uri)
      if (uri === undefined || uri === null || uri.scheme !== 'file') continue
      if (relativePathUnder(uri.fsPath, workspace, platform) !== null) return true
    }
    return false
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
