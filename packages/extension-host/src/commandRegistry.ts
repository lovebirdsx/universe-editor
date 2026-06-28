/**
 * Command registry for the extension host. Owns the map of command id → handler
 * that extensions register through the API bridge, and routes execution: a
 * command this host owns runs its handler locally; anything else is forwarded to
 * a renderer built-in (e.g. `_workbench.openDiff`).
 */
import type { Disposable } from '@universe-editor/extension-api'
import type { IMainThreadCommands } from '@universe-editor/extensions-common'

type CommandHandler = (...args: unknown[]) => unknown

export class ExtensionCommandRegistry {
  private readonly _commands = new Map<string, CommandHandler>()

  constructor(private readonly _mainThreadCommands: IMainThreadCommands) {}

  register(command: string, handler: CommandHandler): Disposable {
    if (this._commands.has(command)) {
      throw new Error(`command already registered: ${command}`)
    }
    this._commands.set(command, handler)
    void this._mainThreadCommands.$registerCommand(command)
    return {
      dispose: () => {
        if (this._commands.delete(command)) {
          void this._mainThreadCommands.$unregisterCommand(command)
        }
      },
    }
  }

  execute(command: string, args: unknown[]): Promise<unknown> {
    const handler = this._commands.get(command)
    if (handler) {
      return Promise.resolve(handler(...args))
    }
    // Not one of this host's commands — forward to a renderer built-in (e.g.
    // `_workbench.openDiff`). The renderer rejects anything outside its
    // host-invokable namespace, so this can't loop back into extension commands.
    return this._mainThreadCommands.$executeCommand(command, args)
  }
}
