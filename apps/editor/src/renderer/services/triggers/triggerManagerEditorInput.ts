/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  TriggerManagerEditorInput — the single virtual tab of the Trigger Manager.
 *  Identity is fixed (a `universe:` URI), so every entry point reveals the same
 *  tab. A pending trigger key is handed to the mounted view; opening the manager
 *  while it is already mounted transfers the key through `updateFrom` and the
 *  selection event instead of opening a second tab.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, Emitter, URI, localize, type Event } from '@universe-editor/platform'

const MANAGER_URI = URI.from({ scheme: 'universe', path: '/triggerManager' })

export interface TriggerManagerEditorInputOptions {
  /** Composite workspace + trigger key to select once the view is mounted. */
  readonly pendingSelection?: string
}

export class TriggerManagerEditorInput extends EditorInput {
  static readonly TYPE_ID = 'trigger.manager'

  private _pendingSelection: string | undefined
  private readonly _onDidChangeSelection: Emitter<string>

  /** Fired when a duplicate open carried a selection the mounted view should reveal. */
  readonly onDidChangeSelection: Event<string>

  constructor(options: TriggerManagerEditorInputOptions = {}) {
    super()
    this._pendingSelection = options.pendingSelection
    this._onDidChangeSelection = this._register(new Emitter<string>())
    this.onDidChangeSelection = this._onDidChangeSelection.event
  }

  override get typeId(): string {
    return TriggerManagerEditorInput.TYPE_ID
  }

  override get resource(): URI {
    return MANAGER_URI
  }

  override getName(): string {
    return localize('trigger.manager.tabTitle', 'Trigger Manager')
  }

  override serialize(): string {
    return ''
  }

  static deserialize(_data?: unknown): TriggerManagerEditorInput {
    // The pending selection is a one-shot hint, not persisted state.
    return new TriggerManagerEditorInput()
  }

  override updateFrom(other: EditorInput): void {
    if (!(other instanceof TriggerManagerEditorInput)) return
    const pending = other.consumePendingSelection()
    if (pending === undefined) return
    this.select(pending)
  }

  /** Ask the mounted view to select {@link key}; also used to transfer a duplicate open. */
  select(key: string): void {
    this._pendingSelection = key
    this._onDidChangeSelection.fire(key)
  }

  /** Read and clear the pending selection; the mounted view calls this once. */
  consumePendingSelection(): string | undefined {
    const value = this._pendingSelection
    this._pendingSelection = undefined
    return value
  }
}
