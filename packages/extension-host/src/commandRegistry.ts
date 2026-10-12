/**
 * Command registry for the extension host. Owns the map of command id → handler
 * that extensions register through the API bridge, and routes the two execution
 * directions apart:
 *
 * - an extension asking for a command ({@link execute}) may be forwarded to a
 *   renderer built-in (e.g. `_workbench.openDiff`) when this host has no handler;
 * - the renderer asking for one of its own contributed commands
 *   ({@link executeContributed}) is answered here and nowhere else, because the
 *   renderer's manifest proxy would route the same id straight back.
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
    if (this._commands.has(command)) {
      return this.executeContributed(command, args)
    }
    // Not one of this host's commands — forward to a renderer built-in (e.g.
    // `_workbench.openDiff`). The renderer rejects anything outside its
    // host-invokable namespace, so this can't loop back into extension commands.
    return this._mainThreadCommands.$executeCommand(command, args)
  }

  /**
   * Run a command the renderer asked this host for. Deliberately WITHOUT the
   * renderer fallback {@link execute} has: the caller IS the renderer, and its
   * manifest proxy for a contributed command would send the same id right back
   * here. Missing means the owning extension never registered a handler — it
   * bailed out of `activate()` (no workspace of its kind) or was never activated
   * for this event — which is what the error says.
   */
  executeContributed(command: string, args: unknown[]): Promise<unknown> {
    const handler = this._commands.get(command)
    if (!handler) {
      return Promise.reject(new Error(`Contributed command '${command}' does not exist.`))
    }
    return Promise.resolve(handler(...args))
  }

  /** Every command id the renderer's registry currently holds (built-in + contributed). */
  getCommands(): Promise<string[]> {
    return this._mainThreadCommands.$getCommands()
  }
}
