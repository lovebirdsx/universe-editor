/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's CommandsRegistry (platform/commands/common/commands.ts).
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../base/event.js'
import { IDisposable, toDisposable } from '../base/lifecycle.js'
import { LinkedList } from '../base/linkedList.js'
import { createDecorator, ServicesAccessor } from '../di/instantiation.js'

export type ICommandHandler = (accessor: ServicesAccessor, ...args: unknown[]) => unknown

export interface ICommandMetadata {
  /** Short human-readable description shown in the command palette. */
  description?: string
  /** Category prefix shown in the command palette. */
  category?: string
}

export interface ICommand {
  id: string
  handler: ICommandHandler
  metadata?: ICommandMetadata
}

export interface ICommandRegistry {
  /** Fired when a command is added or removed. */
  readonly onDidChangeCommands: Event<void>
  registerCommand(id: string, handler: ICommandHandler, metadata?: ICommandMetadata): IDisposable
  registerCommand(command: ICommand): IDisposable
  getCommand(id: string): ICommand | undefined
  getCommands(): ReadonlyMap<string, ICommand>
}

export interface ICommandService {
  readonly _serviceBrand: undefined
  executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T | undefined>
}

export const ICommandService = createDecorator<ICommandService>('commandService')

/**
 * Global command registry. Commands are stored as a LinkedList stack so that later
 * registrations take priority (matching VSCode's behavior).
 */
class CommandsRegistryImpl implements ICommandRegistry {
  private readonly _commands = new Map<string, LinkedList<ICommand>>()
  private readonly _onDidChangeCommands = new Emitter<void>()
  readonly onDidChangeCommands = this._onDidChangeCommands.event

  registerCommand(
    idOrCommand: string | ICommand,
    handler?: ICommandHandler,
    metadata?: ICommandMetadata,
  ): IDisposable {
    let id: string
    let cmd: ICommand

    if (typeof idOrCommand === 'string') {
      if (!handler) {
        throw new Error(`A command handler must be provided.`)
      }
      id = idOrCommand
      cmd = { id, handler, ...(metadata !== undefined ? { metadata } : {}) }
    } else {
      id = idOrCommand.id
      cmd = idOrCommand
    }

    if (!this._commands.has(id)) {
      this._commands.set(id, new LinkedList<ICommand>())
    }

    const list = this._commands.get(id)!
    const removeFn = list.unshift(cmd) // stack: newest first
    this._onDidChangeCommands.fire()

    return toDisposable(() => {
      removeFn()
      if (list.isEmpty()) {
        this._commands.delete(id)
      }
      this._onDidChangeCommands.fire()
    })
  }

  getCommand(id: string): ICommand | undefined {
    const list = this._commands.get(id)
    if (!list || list.isEmpty()) {
      return undefined
    }
    // Newest handler is at the front
    return list.peek() !== undefined ? [...list][0] : undefined
  }

  getCommands(): ReadonlyMap<string, ICommand> {
    const result = new Map<string, ICommand>()
    for (const [id, list] of this._commands) {
      const cmd = [...list][0]
      if (cmd) {
        result.set(id, cmd)
      }
    }
    return result
  }
}

export const CommandsRegistry: ICommandRegistry = new CommandsRegistryImpl()
