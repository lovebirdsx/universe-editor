/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process workspace trust probe. The trusted-folder list is written by the
 *  renderer's WorkspaceTrustManagementService into the application-singleton
 *  state.json, so main can answer "is this folder trusted" without a window. Used
 *  before running a poll command, which executes shell code with the user's rights.
 *--------------------------------------------------------------------------------------------*/

import {
  normalizePlatform,
  normalizeRemoteAuthority,
  relativePathUnder,
  REMOTE_SCHEME,
  URI,
  WORKSPACE_TRUST_STORAGE_KEY,
  type ILogger,
  type UriComponents,
} from '@universe-editor/platform'
import { parseWorkspaceUri } from '../../../shared/triggers/configParse.js'
import type { Storage } from '../../storage.js'

interface StoredTrustInfo {
  readonly uriTrustInfo?: readonly { readonly uri: UriComponents; readonly trusted?: boolean }[]
}

export interface WorkspaceTrustProbeOptions {
  readonly storage: Pick<Storage, 'get'>
  readonly logger: ILogger
}

/**
 * Remote paths follow the remote filesystem, not this machine: keep the
 * comparison case-sensitive (a Windows client can address a Linux remote).
 */
const REMOTE_PLATFORM = normalizePlatform('linux')

/**
 * Mirrors `WorkspaceTrustManagementService`: a folder is trusted when it equals or
 * nests under a stored trusted folder (only `trusted: true` entries are persisted).
 * Entries are matched by URI — `file:` follows the local platform, `remote-ssh:`
 * requires the same authority and a case-sensitive path containment. A read
 * failure is treated as "untrusted" — the caller skips the shell command.
 */
export function createWorkspaceTrustProbe(
  options: WorkspaceTrustProbeOptions,
): (workspaceUri: string) => Promise<boolean> {
  const platform = normalizePlatform(process.platform)
  return async (workspaceUri: string): Promise<boolean> => {
    const target = parseWorkspaceUri(workspaceUri)
    if (target === undefined) return false
    let stored: StoredTrustInfo | undefined
    try {
      stored = await options.storage.get<StoredTrustInfo>(WORKSPACE_TRUST_STORAGE_KEY)
    } catch (err) {
      options.logger.warn(`cannot read the trusted-folder list: ${describeError(err)}`)
      return false
    }
    const targetAuthority =
      target.scheme === REMOTE_SCHEME ? normalizeRemoteAuthority(target.authority) : undefined
    for (const info of stored?.uriTrustInfo ?? []) {
      if (info.trusted !== true) continue
      const trusted = URI.revive(info.uri)
      if (trusted === undefined || trusted === null) continue
      if (trusted.scheme === 'file' && target.scheme === 'file') {
        if (relativePathUnder(trusted.fsPath, target.fsPath, platform) !== null) return true
        continue
      }
      if (trusted.scheme === REMOTE_SCHEME && targetAuthority !== undefined) {
        if (normalizeRemoteAuthority(trusted.authority) !== targetAuthority) continue
        if (relativePathUnder(trusted.path, target.path, REMOTE_PLATFORM) !== null) return true
      }
    }
    return false
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
