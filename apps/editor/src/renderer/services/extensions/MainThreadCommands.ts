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
  type ICommandService,
  type IDisposable,
} from '@universe-editor/platform'
import { type IExtHostCommands, type IMainThreadCommands } from '@universe-editor/extensions-common'

/**
 * Commands the host is allowed to invoke back in the renderer. Restricted to the
 * `_workbench.` internal namespace so host→renderer execution can never re-enter
 * an extension-contributed command (which would route back to the host and loop).
 */
const HOST_INVOKABLE_PREFIX = '_workbench.'

/** Notifies the owner which connection owns a runtime-registered command (for routing). */
export interface CommandOwnershipLedger {
  claim(id: string): void
  release(id: string): void
}

export class MainThreadCommands extends Disposable implements IMainThreadCommands {
  private readonly _registrations = new Map<string, IDisposable>()

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
    this._registrations.get(id)?.dispose()
    this._registrations.delete(id)
    this._ledger?.release(id)
    return Promise.resolve()
  }

  $executeCommand(id: string, args: unknown[]): Promise<unknown> {
    if (!id.startsWith(HOST_INVOKABLE_PREFIX)) {
      return Promise.reject(
        new Error(
          `extension host may only execute ${HOST_INVOKABLE_PREFIX}* commands, not "${id}"`,
        ),
      )
    }
    return this._commandService.executeCommand(id, ...args)
  }

  override dispose(): void {
    for (const reg of this._registrations.values()) reg.dispose()
    this._registrations.clear()
    super.dispose()
  }
}
