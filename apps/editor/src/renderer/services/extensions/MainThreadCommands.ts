/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side handler for the host → renderer `mainThreadCommands` channel.
 *  When an extension registers a command at runtime (one not already known from
 *  its manifest), the host calls `$registerCommand`; we install a CommandsRegistry
 *  handler that forwards execution back to the host. Commands already present
 *  (manifest bootstrap proxies) are left untouched — they already route to the
 *  host and carry their palette title.
 *--------------------------------------------------------------------------------------------*/

import {
  CommandsRegistry,
  Disposable,
  DisposableMap,
  type ICommandService,
  type IDisposable,
} from '@universe-editor/platform'
import { type IExtHostCommands, type IMainThreadCommands } from '@universe-editor/extensions-common'

/**
 * Commands the host is allowed to invoke back in the renderer: the `_workbench.*`
 * bridge namespace, plus VSCode-compatible built-in command ids added one by one.
 * This is a namespace boundary — extensions talk to the workbench through
 * `_workbench.*`, and an id outside it is either a bug or a capability this repo
 * has not decided to expose. It is NOT the loop guard it started as: the host now
 * rejects an unregistered contributed command itself
 * (`ExtensionCommandRegistry.executeContributed`), so a host→renderer→host bounce
 * ends on the first hop instead of spinning.
 */
const HOST_INVOKABLE_PREFIX = '_workbench.'
const HOST_INVOKABLE_BUILT_INS = new Set(['revealInExplorer', 'setContext'])

function isHostInvokableCommand(id: string): boolean {
  return id.startsWith(HOST_INVOKABLE_PREFIX) || HOST_INVOKABLE_BUILT_INS.has(id)
}

/** Notifies the owner which connection owns a runtime-registered command (for routing). */
export interface CommandOwnershipLedger {
  claim(id: string): void
  release(id: string): void
}

export class MainThreadCommands extends Disposable implements IMainThreadCommands {
  private readonly _registrations = this._register(new DisposableMap<string, IDisposable>())

  constructor(
    private readonly _extHostCommands: IExtHostCommands,
    private readonly _commandService: ICommandService,
    private readonly _ledger?: CommandOwnershipLedger,
  ) {
    super()
  }

  $registerCommand(id: string): Promise<void> {
    if (this._registrations.has(id) || CommandsRegistry.getCommand(id)) {
      return Promise.resolve()
    }
    const reg = CommandsRegistry.registerCommand({
      id,
      handler: (_accessor, ...args) => this._extHostCommands.$executeContributedCommand(id, args),
      metadata: { description: id },
    })
    this._registrations.set(id, reg)
    this._ledger?.claim(id)
    return Promise.resolve()
  }

  $unregisterCommand(id: string): Promise<void> {
    this._registrations.deleteAndDispose(id)
    this._ledger?.release(id)
    return Promise.resolve()
  }

  $getCommands(): Promise<string[]> {
    return Promise.resolve([...CommandsRegistry.getCommands().keys()])
  }

  $executeCommand(id: string, args: unknown[]): Promise<unknown> {
    if (!isHostInvokableCommand(id)) {
      return Promise.reject(
        new Error(
          `extension host may only execute ${HOST_INVOKABLE_PREFIX}* commands or allowlisted built-ins, not "${id}"`,
        ),
      )
    }
    return this._commandService.executeCommand(id, ...args)
  }
}
