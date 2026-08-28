/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ICommandService implementation for the renderer process.
 *--------------------------------------------------------------------------------------------*/

import type { ICommandService, ILogger, ITelemetryService } from '@universe-editor/platform'
import { CommandsRegistry } from '@universe-editor/platform'
import type { InstantiationService } from '@universe-editor/platform'
import { NullLogger } from '@universe-editor/platform'
import { isBenignError } from '../../errors.js'

/** Bug recording sink; only the failure paths report here (telemetry covers success). */
export interface ICommandFailureRecorder {
  recordEvent(event: { kind: 'commandError'; commandId: string; message: string }): void
}

export class CommandService implements ICommandService {
  declare readonly _serviceBrand: undefined

  constructor(
    private readonly _instantiation: InstantiationService,
    private readonly _telemetry?: ITelemetryService,
    private readonly _logger: ILogger = new NullLogger(),
    private readonly _recorder?: ICommandFailureRecorder,
  ) {}

  executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T | undefined> {
    const command = CommandsRegistry.getCommand(id)
    if (!command) {
      this._logger.warn(`command not found id=${id}`)
      this._recorder?.recordEvent({
        kind: 'commandError',
        commandId: id,
        message: 'command not found',
      })
      return Promise.resolve(undefined)
    }
    try {
      const result = this._instantiation.invokeFunction(
        (accessor) => command.handler(accessor, ...args) as T,
      )
      return Promise.resolve(result).then(
        (value) => {
          this._telemetry?.publicLog('commandExecuted', { commandId: id })
          this._logger.debug(`command executed id=${id}`)
          return value
        },
        (err: unknown) => {
          this._logFailure(id, err)
          return Promise.reject(err)
        },
      )
    } catch (err) {
      this._logFailure(id, err)
      return Promise.reject(err)
    }
  }

  /**
   * A rejection the workbench already accounts for — e.g. an in-flight request
   * whose IPC channel was torn down by an extension-host restart — is lifecycle
   * noise the caller handles by keeping stale state; it must not surface as an
   * error-level log on every restart. Genuine handler failures stay errors.
   */
  private _logFailure(id: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    this._recorder?.recordEvent({ kind: 'commandError', commandId: id, message })
    if (isBenignError(err)) {
      this._logger.warn(`command interrupted id=${id}`, err)
      return
    }
    this._logger.error(`command failed id=${id}`, err)
  }
}
