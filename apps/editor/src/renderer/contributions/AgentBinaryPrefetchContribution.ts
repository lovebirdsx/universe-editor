/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Idle-time background prefetch of the native Claude / codex-acp binaries so a
 *  later upgrade activates instantly instead of waiting on a ~80MB download. Runs
 *  only in download mode and only when `acp.prefetchBinaries` is enabled; failures
 *  are swallowed (best-effort, never disrupts the user).
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IConfigurationService,
  type ILogger,
  ILoggerService,
  type IWorkbenchContribution,
  createNamedLogger,
  runWhenIdle,
} from '@universe-editor/platform'
import { IClaudeBinaryService } from '../../shared/ipc/claudeBinaryService.js'
import { ICodexBinaryService } from '../../shared/ipc/codexBinaryService.js'

export class AgentBinaryPrefetchContribution extends Disposable implements IWorkbenchContribution {
  private readonly _logger: ILogger

  constructor(
    @IConfigurationService private readonly _config: IConfigurationService,
    @IClaudeBinaryService private readonly _claude: IClaudeBinaryService,
    @ICodexBinaryService private readonly _codex: ICodexBinaryService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, {
      id: 'agentBinaryPrefetch',
      name: 'Agent Binary Prefetch',
    })

    if (this._config.get<boolean>('acp.prefetchBinaries') === false) return

    this._register(runWhenIdle(globalThis, () => void this._prefetch()))
  }

  private async _prefetch(): Promise<void> {
    if ((this._config.get<string>('acp.claude.source') ?? 'download') === 'download') {
      try {
        await this._claude.prefetch()
      } catch (err) {
        this._logger.warn(`claude binary prefetch failed: ${String(err)}`)
      }
    }
    if ((this._config.get<string>('acp.codex.source') ?? 'download') === 'download') {
      try {
        await this._codex.prefetch()
      } catch (err) {
        this._logger.warn(`codex-acp binary prefetch failed: ${String(err)}`)
      }
    }
  }
}
