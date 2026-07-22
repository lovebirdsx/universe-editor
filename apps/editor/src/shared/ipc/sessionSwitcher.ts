/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Cross-window session switcher contracts.
 *
 *  Two channels cooperate:
 *    - ISessionSwitcherService (forward, main impl): the focused window asks main
 *      to aggregate every window's live sessions, and to reveal a chosen one.
 *    - IRendererSessionsService (reverse, renderer impl): main fans out to each
 *      window to list its live sessions and to reveal one locally.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator, type Event } from '@universe-editor/platform'

/** A live session as reported by a renderer, before main tags window metadata. */
export interface RendererSessionSummary {
  readonly sessionId: string
  readonly title: string
  /** Serialized `AcpSessionDisplayStatus` (e.g. 'running' | 'idle' | 'ask' | …). */
  readonly status: string
  readonly agentId: string
}

/** A live session tagged with the owning window + workspace by main. */
export interface SessionSummary extends RendererSessionSummary {
  readonly windowId: number
  /** Workspace folder name (directory basename); empty for an untitled window. */
  readonly workspaceName: string
}

/** Live running/ask session counts. */
export interface SessionStatusCounts {
  readonly running: number
  readonly ask: number
}

/** Forward channel: implemented in main, called from the focused renderer. */
export interface ISessionSwitcherService {
  readonly _serviceBrand: undefined
  /** Aggregate live sessions across every open window. */
  getAllSessions(): Promise<readonly SessionSummary[]>
  /** Focus the owning window and open the session in its editor area. */
  reveal(windowId: number, sessionId: string): Promise<void>
  /** Aggregate running/ask counts across every open window. */
  getSessionCounts(): Promise<SessionStatusCounts>
  /**
   * Report the calling window's live counts. The channel is window-scoped (main
   * tags the windowId); main rebroadcasts the aggregate via onDidChangeCounts.
   */
  reportSessionCounts(counts: SessionStatusCounts): Promise<void>
  /** Fires in every window when the aggregate counts change. */
  readonly onDidChangeCounts: Event<SessionStatusCounts>
}

export const ISessionSwitcherService =
  createDecorator<ISessionSwitcherService>('sessionSwitcherService')

/** Reverse channel: implemented in each renderer, called from main. */
export interface IRendererSessionsService {
  readonly _serviceBrand: undefined
  listSessions(): Promise<readonly RendererSessionSummary[]>
  reveal(sessionId: string): Promise<void>
}

export const IRendererSessionsService =
  createDecorator<IRendererSessionsService>('rendererSessionsService')
