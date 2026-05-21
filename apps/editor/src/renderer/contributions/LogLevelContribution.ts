/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Applies the user's configured `logging.level` to the renderer logger service
 *  and propagates it to the main process via ILogFilesService.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IConfigurationService,
  ILoggerService,
  LOG_TIMESTAMP_FORMAT_DEFAULT,
  LogLevel,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { ILogFilesService } from '../../shared/ipc/services.js'

const LEVEL_MAP: Record<string, LogLevel> = {
  off: LogLevel.Off,
  trace: LogLevel.Trace,
  debug: LogLevel.Debug,
  info: LogLevel.Info,
  warning: LogLevel.Warning,
  error: LogLevel.Error,
}

export function parseLogLevel(value: unknown): LogLevel | undefined {
  if (typeof value !== 'string') return undefined
  return LEVEL_MAP[value]
}

export class LogLevelContribution extends Disposable implements IWorkbenchContribution {
  private _applied: LogLevel | undefined
  private _appliedFormat: string | undefined

  constructor(
    @IConfigurationService private readonly _configuration: IConfigurationService,
    @ILoggerService private readonly _loggerService: ILoggerService,
    @ILogFilesService private readonly _logFiles: ILogFilesService,
  ) {
    super()
    void this._apply()
    this._register(
      this._configuration.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('logging.level') ||
          e.affectsConfiguration('logging.timestampFormat')
        ) {
          void this._apply()
        }
      }),
    )
  }

  private async _apply(): Promise<void> {
    const level = parseLogLevel(this._configuration.get('logging.level'))
    if (level !== undefined && level !== this._applied) {
      this._applied = level
      this._loggerService.setLevel(level)
      try {
        await this._logFiles.setLogLevel(level)
      } catch {
        // Best-effort: main-side level sync is non-critical at startup.
      }
    }

    const fmt =
      this._configuration.get<string>('logging.timestampFormat') ?? LOG_TIMESTAMP_FORMAT_DEFAULT
    if (fmt !== this._appliedFormat) {
      this._appliedFormat = fmt
      try {
        await this._logFiles.setTimestampFormat(fmt)
      } catch {
        // Best-effort
      }
    }
  }
}
