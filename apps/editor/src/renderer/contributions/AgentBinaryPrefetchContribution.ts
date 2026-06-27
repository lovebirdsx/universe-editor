/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Idle-time maintenance of the native Claude / codex-acp binaries:
 *    1. Sweeps stale (non-active) version dirs left by a previous upgrade — the
 *       predecessor binary is locked while a session runs, so cleanup is deferred
 *       to the next launch when its lock is gone. Always runs.
 *    2. Background-prefetches the latest binary so a later upgrade activates
 *       instantly instead of waiting on a ~80MB download. Runs only in download
 *       mode and only when `acp.prefetchBinaries` is enabled.
 *  All failures are swallowed (best-effort, never disrupts the user).
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

    this._register(runWhenIdle(globalThis, () => void this._run()))
  }

  private async _run(): Promise<void> {
    await this._cleanup()
    if (this._config.get<boolean>('acp.prefetchBinaries') === false) return
    await this._prefetch()
  }

  /** Sweep stale version dirs from a prior upgrade; the old binary's lock is gone now. */
  private async _cleanup(): Promise<void> {
    try {
      await this._claude.cleanupStaleVersions()
    } catch (err) {
      this._logger.warn(`claude binary cleanup failed: ${String(err)}`)
    }
    try {
      await this._codex.cleanupStaleVersions()
    } catch (err) {
      this._logger.warn(`codex-acp binary cleanup failed: ${String(err)}`)
    }
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
