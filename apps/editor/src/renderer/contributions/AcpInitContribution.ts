/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpInitContribution — drives the fire-and-forget initialize() of the ACP
 *  persisted-state services that used to run inline in bootstrap.
 *
 *  All three are registerSingleton services. History + agent-defaults are also
 *  injected by AcpSessionService (constructed in bootstrap), so by the time this
 *  contribution runs they are already materialized — we just kick their hydration.
 *  ChatLocation depends on IAcpSessionService (available since bootstrap) and is
 *  materialized here. Order mirrors the previous bootstrap sequence; initialize()
 *  is fire-and-forget (early state merges in once hydration completes).
 *--------------------------------------------------------------------------------------------*/

import { Disposable, type IWorkbenchContribution } from '@universe-editor/platform'
import { IAcpSessionHistoryService } from '../services/acp/acpSessionHistory.js'
import { IAcpAgentDefaultsService } from '../services/acp/acpAgentDefaultsService.js'
import { IAcpChatLocationService } from '../services/acp/acpChatLocationService.js'

export class AcpInitContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IAcpSessionHistoryService history: IAcpSessionHistoryService,
    @IAcpAgentDefaultsService agentDefaults: IAcpAgentDefaultsService,
    @IAcpChatLocationService chatLocation: IAcpChatLocationService,
  ) {
    super()
    void history.initialize()
    void agentDefaults.initialize()
    void chatLocation.initialize()
  }
}
