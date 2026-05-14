/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ICommandService implementation for the renderer process.
 *--------------------------------------------------------------------------------------------*/

import type { ICommandService } from '@universe-editor/platform'
import { CommandsRegistry } from '@universe-editor/platform'
import type { InstantiationService } from '@universe-editor/platform'

export class CommandService implements ICommandService {
  declare readonly _serviceBrand: undefined

  constructor(private readonly _instantiation: InstantiationService) {}

  executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T | undefined> {
    const command = CommandsRegistry.getCommand(id)
    if (!command) {
      console.warn(`[CommandService] Command not found: "${id}"`)
      return Promise.resolve(undefined)
    }
    try {
      const result = this._instantiation.invokeFunction(
        (accessor) => command.handler(accessor, ...args) as T,
      )
      return Promise.resolve(result)
    } catch (err) {
      return Promise.reject(err)
    }
  }
}
