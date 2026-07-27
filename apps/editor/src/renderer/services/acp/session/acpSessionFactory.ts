/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpSessionFactory — builds AcpSession instances with their collaborator
 *  services wired in. Extracted from AcpSessionService (roadmap 06 · task 1):
 *  the change tracker, title service, and compaction-stats service were injected
 *  into the facade *solely* to thread into `new AcpSession(...)`. Moving that
 *  construction here keeps those dependencies off the facade's inject list and
 *  gives the two call sites (new session / resumed session) one typed entry point.
 *--------------------------------------------------------------------------------------------*/

import {
  ITelemetryService,
  InstantiationType,
  createDecorator,
  registerSingleton,
} from '@universe-editor/platform'
import { AcpSession } from './acpSession.js'
import type { IAcpSessionInitState } from './acpSessionModel.js'
import type { CollapseMode } from './acpChatViewStateCache.js'
import { IAcpSessionHistoryService } from './acpSessionHistory.js'
import { IAcpAgentDefaultsService } from './acpAgentDefaultsService.js'
import { ISessionChangeTrackerService } from './sessionChangeTracker.js'
import { IAcpSessionTitleService } from './acpSessionTitleService.js'
import { IAcpCompactionStatsService } from './acpCompactionStats.js'

export interface IAcpSessionCreateOptions {
  readonly id: string
  readonly agentId: string
  readonly title: string
  readonly initState?: IAcpSessionInitState
  readonly collapseMode?: CollapseMode
  readonly readOnly?: boolean
  /**
   * Whether the session may auto-generate an AI title from its opening exchange.
   * New sessions want this; resumed sessions already carry a durable title and
   * must NOT regenerate (and overwrite) it, so they pass `false`.
   */
  readonly withTitleService?: boolean
}

export interface IAcpSessionFactory {
  readonly _serviceBrand: undefined
  create(opts: IAcpSessionCreateOptions): AcpSession
}

export const IAcpSessionFactory = createDecorator<IAcpSessionFactory>('acpSessionFactory')

export class AcpSessionFactory implements IAcpSessionFactory {
  declare readonly _serviceBrand: undefined

  constructor(
    @ITelemetryService private readonly _telemetry: ITelemetryService,
    @IAcpSessionHistoryService private readonly _history: IAcpSessionHistoryService,
    @IAcpAgentDefaultsService private readonly _agentDefaults: IAcpAgentDefaultsService,
    @ISessionChangeTrackerService private readonly _changeTracker: ISessionChangeTrackerService,
    @IAcpSessionTitleService private readonly _titleService: IAcpSessionTitleService,
    @IAcpCompactionStatsService private readonly _compactionStats: IAcpCompactionStatsService,
  ) {}

  create(opts: IAcpSessionCreateOptions): AcpSession {
    return new AcpSession(
      opts.id,
      opts.agentId,
      opts.title,
      this._telemetry,
      opts.initState,
      opts.collapseMode ?? 'default',
      this._history,
      this._agentDefaults,
      this._changeTracker,
      opts.withTitleService ? this._titleService : undefined,
      opts.readOnly ?? false,
      this._compactionStats,
    )
  }
}

registerSingleton(IAcpSessionFactory, AcpSessionFactory, InstantiationType.Delayed)
