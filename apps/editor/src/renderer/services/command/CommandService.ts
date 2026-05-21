/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ICommandService implementation for the renderer process.
 *--------------------------------------------------------------------------------------------*/

import type { ICommandService, ILogger, ITelemetryService } from '@universe-editor/platform'
import { CommandsRegistry } from '@universe-editor/platform'
import type { InstantiationService } from '@universe-editor/platform'
import { NullLogger } from '@universe-editor/platform'

export class CommandService implements ICommandService {
  declare readonly _serviceBrand: undefined

  constructor(
    private readonly _instantiation: InstantiationService,
    private readonly _telemetry?: ITelemetryService,
    private readonly _logger: ILogger = new NullLogger(),
  ) {}

  executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T | undefined> {
    const command = CommandsRegistry.getCommand(id)
    if (!command) {
      this._logger.warn(`command not found id=${id}`)
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
          this._logger.error(`command failed id=${id}`, err)
          return Promise.reject(err)
        },
      )
    } catch (err) {
      this._logger.error(`command failed id=${id}`, err)
      return Promise.reject(err)
    }
  }
}
