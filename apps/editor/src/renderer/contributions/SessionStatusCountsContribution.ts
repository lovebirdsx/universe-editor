/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Reports this window's live running/ask session counts to main, which
 *  aggregates across windows and rebroadcasts the total (consumed by the
 *  title-bar agent pill via ISessionSwitcherService.onDidChangeCounts).
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  ILoggerService,
  IWorkbenchContribution,
  autorun,
  type ILogger,
} from '@universe-editor/platform'
import { IAcpSessionService } from '../services/acp/session/acpSessionService.js'
import { computeSessionDisplayStatus } from '../services/acp/session/acpSessionStatus.js'
import { ISessionSwitcherService } from '../../shared/ipc/sessionSwitcher.js'

export class SessionStatusCountsContribution extends Disposable implements IWorkbenchContribution {
  private readonly _logger: ILogger

  constructor(
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @ISessionSwitcherService private readonly _switcher: ISessionSwitcherService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'sessionCounts', name: 'Session Counts' })

    this._register(
      autorun((r) => {
        let running = 0
        let ask = 0
        for (const session of this._sessions.sessions.read(r)) {
          const status = computeSessionDisplayStatus(session, r)
          // Background tasks keep real work going past the prompt RPC — the
          // pill (and the quit guard it feeds) must count them as active.
          if (status === 'running' || status === 'background') running++
          else if (status === 'ask') ask++
        }
        void this._switcher
          .reportSessionCounts({ running, ask })
          .catch((err) => this._logger.warn('reportSessionCounts failed', err))
      }),
    )
  }
}
