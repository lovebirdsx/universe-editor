/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Syncs `-command` disable entries from keybindings.json to Monaco's *internal*
 *  keybinding dispatch. A `-editor.action.insertCursorAbove` entry only removes
 *  the binding from our KeybindingsRegistry — but Monaco built-in default keys
 *  live in Monaco's own dispatcher (not our registry; the bridge keeps them in a
 *  side-table), so while the editor is focused Monaco still consumes the key and
 *  stopPropagation()s it. To actually free the key, we mirror the disable onto
 *  Monaco via `addKeybindingRule({ keybinding: 0, command: '-<id>' })` — the same
 *  mechanism MonacoLoader uses to drop quickOutline's default key. Disposing the
 *  rule restores Monaco's default, so undoing a disable in keybindings.json
 *  reinstates the original key.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  type IDisposable,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { IUserKeybindingsService } from '../services/keybindings/UserKeybindingsService.js'
import { MonacoLoader } from '../workbench/editor/monaco/MonacoLoader.js'
import { getMonacoDefaultKeybinding } from '../workbench/editor/monaco/monacoActionsBridge.js'

/**
 * Pure diff: given the commands that should currently be unbound on the Monaco
 * side and the set already unbound, return which to add and which to restore.
 */
export function diffMonacoDisabled(
  desired: ReadonlySet<string>,
  applied: ReadonlySet<string>,
): { toAdd: string[]; toRemove: string[] } {
  const toAdd: string[] = []
  const toRemove: string[] = []
  for (const id of desired) if (!applied.has(id)) toAdd.push(id)
  for (const id of applied) if (!desired.has(id)) toRemove.push(id)
  return { toAdd, toRemove }
}

export class MonacoDefaultKeybindingOverrideContribution
  extends Disposable
  implements IWorkbenchContribution
{
  private readonly _applied = new Map<string, IDisposable>()

  constructor(@IUserKeybindingsService private readonly _userKeybindings: IUserKeybindingsService) {
    super()

    if (MonacoLoader.actionsBridged) {
      this._sync()
    } else {
      this._register(MonacoLoader.onDidBridgeActions(() => this._sync()))
    }
    this._register(this._userKeybindings.onDidChange(() => this._sync()))
    this._register({
      dispose: () => {
        for (const d of this._applied.values()) d.dispose()
        this._applied.clear()
      },
    })
  }

  private _sync(): void {
    const monaco = MonacoLoader.peek()
    // Monaco not loaded yet → its dispatcher doesn't exist, so nothing consumes
    // the key. We'll sync once the action bridge fires after the first load.
    if (!monaco) return

    const desired = new Set(
      this._userKeybindings.disabledCommands.filter(
        (id) => getMonacoDefaultKeybinding(id) !== undefined,
      ),
    )
    const { toAdd, toRemove } = diffMonacoDisabled(desired, new Set(this._applied.keys()))

    for (const id of toRemove) {
      this._applied.get(id)?.dispose()
      this._applied.delete(id)
    }
    for (const id of toAdd) {
      this._applied.set(id, monaco.editor.addKeybindingRule({ keybinding: 0, command: `-${id}` }))
    }
  }
}
