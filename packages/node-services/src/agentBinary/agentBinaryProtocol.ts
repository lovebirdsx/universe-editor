/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Remote agent-binary channel surface. The local main process proxies this over
 *  the Management connection when the active workspace is remote; the remote
 *  server implements it with the shared AgentBinaryStore so the binary is
 *  downloaded onto the remote host — never the local userData.
 *--------------------------------------------------------------------------------------------*/

import type { AgentBinaryVersionPolicy, Event } from '@universe-editor/platform'
import type { AgentBinaryId } from './flavors.js'
import type { AgentBinaryDownloadState, AgentBinaryVersionInfo } from './agentBinaryStore.js'

export interface AgentBinaryRemoteDownloadEvent {
  readonly agent: AgentBinaryId
  /** In-flight downloads; empty means the agent's store went idle. */
  readonly downloads: readonly AgentBinaryDownloadState[]
}

/**
 * Served on RemoteChannels.AgentBinary. Returned paths are remote-native path
 * strings (documented exception to the URI-only DTO rule).
 */
export interface IRemoteAgentBinaryService {
  readonly _serviceBrand: undefined

  readonly onDidChangeDownload: Event<AgentBinaryRemoteDownloadEvent>

  resolve(
    agent: AgentBinaryId,
    opts: { readonly allowDownload?: boolean; readonly policy: AgentBinaryVersionPolicy },
  ): Promise<{ readonly path: string }>

  getVersionInfo(
    agent: AgentBinaryId,
    policy: AgentBinaryVersionPolicy,
  ): Promise<AgentBinaryVersionInfo>

  forceDownload(agent: AgentBinaryId, version: string): Promise<{ readonly path: string }>

  /**
   * Background-prefetches the most desirable version into that version's own dir
   * without activating it, so a later forceDownload needs no network: the
   * registry's latest under `'manual'`, the pin under `'pinned'` (which never
   * consults the registry at all). Managed download only — remote callers never
   * resolve system/custom sources. Never rejects.
   */
  prefetch(agent: AgentBinaryId, policy: AgentBinaryVersionPolicy): Promise<void>

  /**
   * Removes version dirs outside the keep-set (active, pinned/bundled, last-seen
   * latest) left by a previous upgrade. Best-effort; safe to call only at
   * startup/idle.
   */
  cleanupStaleVersions(agent: AgentBinaryId): Promise<void>

  /**
   * Aligns that host's managed-download tree with the current pin after an editor
   * upgrade changed it, so a remote session stops running the previous pin's
   * binary. `version` is the pin it switched to, or null when nothing was done:
   * the pin never changed since the last alignment, no managed version exists yet,
   * or the alignment failed (it is retried on the next session). Best-effort and
   * only meaningful at startup/idle.
   */
  syncBundled(agent: AgentBinaryId): Promise<{ readonly version: string | null }>
}
