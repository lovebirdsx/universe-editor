/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Remote agent-binary channel surface. The local main process proxies this over
 *  the Management connection when the active workspace is remote; the remote
 *  server implements it with the shared AgentBinaryStore so the binary is
 *  downloaded onto the remote host — never the local userData.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '@universe-editor/platform'
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
    opts: { readonly allowDownload?: boolean },
  ): Promise<{ readonly path: string }>

  getVersionInfo(agent: AgentBinaryId): Promise<AgentBinaryVersionInfo>

  forceDownload(agent: AgentBinaryId, version: string): Promise<{ readonly path: string }>

  /**
   * Background-prefetches the most desirable version (latest when available,
   * otherwise the bundled/pinned version) into that version's own dir without
   * activating it, so a later forceDownload needs no network. Managed download
   * only — remote callers never resolve system/custom sources. Never rejects.
   */
  prefetch(agent: AgentBinaryId): Promise<void>

  /**
   * Removes version dirs outside the keep-set (active, pinned/bundled, last-seen
   * latest) left by a previous upgrade. Best-effort; safe to call only at
   * startup/idle.
   */
  cleanupStaleVersions(agent: AgentBinaryId): Promise<void>
}
