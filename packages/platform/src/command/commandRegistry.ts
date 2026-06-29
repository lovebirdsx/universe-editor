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
  /**
   * Original (English) form of {@link description}, kept so the command palette
   * can match the English title under a non-English display language.
   */
  originalDescription?: string
  /** Original (English) form of {@link category}. */
  originalCategory?: string
}

export interface ICommand {
  id: string
  handler: ICommandHandler
  metadata?: ICommandMetadata
}

export interface ICommandRegistrationOptions {
  /**
   * Suppress the duplicate-id warning. Set this when intentionally overriding an
   * existing command (matching VSCode's override semantics).
   */
  allowOverride?: boolean
}

export interface ICommandRegistry {
  /** Fired when a command is added or removed. */
  readonly onDidChangeCommands: Event<void>
  registerCommand(
    id: string,
    handler: ICommandHandler,
    metadata?: ICommandMetadata,
    options?: ICommandRegistrationOptions,
  ): IDisposable
  registerCommand(command: ICommand, options?: ICommandRegistrationOptions): IDisposable
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
    handlerOrOptions?: ICommandHandler | ICommandRegistrationOptions,
    metadata?: ICommandMetadata,
    options?: ICommandRegistrationOptions,
  ): IDisposable {
    let id: string
    let cmd: ICommand
    let opts: ICommandRegistrationOptions | undefined

    if (typeof idOrCommand === 'string') {
      const handler = handlerOrOptions as ICommandHandler | undefined
      if (!handler) {
        throw new Error(`A command handler must be provided.`)
      }
      id = idOrCommand
      cmd = { id, handler, ...(metadata !== undefined ? { metadata } : {}) }
      opts = options
    } else {
      id = idOrCommand.id
      cmd = idOrCommand
      opts = handlerOrOptions as ICommandRegistrationOptions | undefined
    }

    let list = this._commands.get(id)
    if (!list) {
      list = new LinkedList<ICommand>()
      this._commands.set(id, list)
    } else if (!list.isEmpty() && !opts?.allowOverride) {
      // A handler already exists for this id. Registration still wins (newest-first,
      // matching VSCode), but a silent override is a frequent source of hard-to-trace
      // bugs once multiple contributors (and extensions) participate.
      console.warn(
        `[CommandsRegistry] duplicate command id '${id}' — the new handler overrides the existing one. ` +
          `Pass { allowOverride: true } to silence this if intentional.`,
      )
    }

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
