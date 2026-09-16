/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpInitContribution — drives the fire-and-forget initialize() of the ACP
 *  persisted-state services that used to run inline in bootstrap.
 *
 *  All of them are registerSingleton services. History + agent-defaults are also
 *  injected by AcpSessionService (constructed in bootstrap), so by the time this
 *  contribution runs they are already materialized — we just kick their hydration.
 *  initialize() is fire-and-forget (early state merges in once hydration completes).
 *--------------------------------------------------------------------------------------------*/

import { Disposable, type IWorkbenchContribution } from '@universe-editor/platform'
import { IAcpSessionHistoryService } from '../services/acp/session/acpSessionHistory.js'
import { IAcpAgentDefaultsService } from '../services/acp/session/acpAgentDefaultsService.js'
import { IAcpConfigOptionsCacheService } from '../services/acp/session/acpConfigOptionsCache.js'
import { IAcpCompactionStatsService } from '../services/acp/session/acpCompactionStats.js'
import { ISessionChangeTrackerService } from '../services/acp/session/sessionChangeTracker.js'
import { IAcpSessionFilterService } from '../services/acp/session/acpSessionFilterService.js'
import { ISessionBookmarkService } from '../services/acp/session/sessionBookmarkService.js'
import { IAcpLastSessionCwdService } from '../services/acp/session/acpLastSessionCwdService.js'

export class AcpInitContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IAcpSessionHistoryService history: IAcpSessionHistoryService,
    @IAcpAgentDefaultsService agentDefaults: IAcpAgentDefaultsService,
    @IAcpConfigOptionsCacheService configOptionsCache: IAcpConfigOptionsCacheService,
    @IAcpCompactionStatsService compactionStats: IAcpCompactionStatsService,
    @ISessionChangeTrackerService changeTracker: ISessionChangeTrackerService,
    @IAcpSessionFilterService sessionFilter: IAcpSessionFilterService,
    @ISessionBookmarkService sessionBookmarks: ISessionBookmarkService,
    @IAcpLastSessionCwdService lastSessionCwd: IAcpLastSessionCwdService,
  ) {
    super()
    void history.initialize()
    void agentDefaults.initialize()
    void configOptionsCache.initialize()
    void compactionStats.initialize()
    void changeTracker.initialize()
    void sessionFilter.initialize()
    void sessionBookmarks.initialize()
    void lastSessionCwd.initialize()
  }
}
