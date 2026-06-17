import {
  autorun,
  EditorInput,
  generateUuid,
  IInstantiationService,
  observableValue,
  URI,
  type IObservable,
  type ISettableObservable,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { ITerminalManagerService } from '../terminal/TerminalManagerService.js'

/**
 * Spec used to (re)spawn the backing pty when an editor terminal is restored
 * across a window restart — the previous pty is long gone, so we start a fresh
 * one with the same shell/cwd. Live inputs created in-session pass `terminalId`
 * directly and skip respawn.
 */
interface ITerminalEditorRestoreSpec {
  shell?: string
  cwd?: string
}

export class TerminalEditorInput extends EditorInput {
  static readonly TYPE_ID = 'terminal.editor'

  // Stable identity decoupled from the terminalId: a restored input must keep a
  // constant resource while its pty is (re)spawned asynchronously.
  private readonly _resource: URI
  private _label: string

  // The backing terminal id. Undefined until a respawned pty is ready (restore
  // path); set synchronously for live inputs.
  private readonly _terminalId: ISettableObservable<string | undefined>
  readonly terminalId: IObservable<string | undefined>

  // What to persist so a restart can respawn the pty.
  private _shell: string | undefined
  private _cwd: string | undefined

  constructor(
    initialTerminalId: string | undefined,
    initialLabel: string,
    restoreSpec: ITerminalEditorRestoreSpec | undefined,
    @ITerminalManagerService private readonly _manager: ITerminalManagerService,
  ) {
    super()
    this._resource = URI.from({ scheme: 'universe', path: `/terminal/editor/${generateUuid()}` })
    this._label = initialLabel
    this._shell = restoreSpec?.shell
    this._cwd = restoreSpec?.cwd
    this._terminalId = observableValue<string | undefined>('terminalEditor.id', initialTerminalId)
    this.terminalId = this._terminalId

    if (initialTerminalId === undefined) {
      void this._respawn(restoreSpec)
    } else {
      this._captureSpec(initialTerminalId)
    }

    this._register(
      autorun((r) => {
        const id = this._terminalId.read(r)
        if (id === undefined) return
        const info = this._manager.terminals.read(r).find((t) => t.id === id)
        if (info && info.name !== this._label) {
          this._label = info.name
          this._onDidChangeLabel.fire()
        }
      }),
    )
  }

  override get typeId(): string {
    return TerminalEditorInput.TYPE_ID
  }

  override get resource(): URI {
    return this._resource
  }

  override getName(): string {
    return this._label
  }

  override getIconId(): string {
    return 'terminal'
  }

  override focus(): boolean {
    const id = this._terminalId.get()
    if (!id) return false
    this._manager.focusTerminal(id)
    return true
  }

  override serialize(): string {
    return JSON.stringify({
      label: this._label,
      ...(this._shell !== undefined ? { shell: this._shell } : {}),
      ...(this._cwd !== undefined ? { cwd: this._cwd } : {}),
    })
  }

  static deserialize(data: unknown, accessor?: ServicesAccessor): TerminalEditorInput | null {
    if (typeof data !== 'string' || !accessor) return null
    try {
      const parsed = JSON.parse(data) as { label?: unknown; shell?: unknown; cwd?: unknown }
      const label = typeof parsed.label === 'string' ? parsed.label : 'Terminal'
      const restoreSpec: ITerminalEditorRestoreSpec = {
        ...(typeof parsed.shell === 'string' ? { shell: parsed.shell } : {}),
        ...(typeof parsed.cwd === 'string' ? { cwd: parsed.cwd } : {}),
      }
      const inst = accessor.get(IInstantiationService)
      return inst.createInstance(TerminalEditorInput, undefined, label, restoreSpec)
    } catch {
      return null
    }
  }

  override dispose(): void {
    const id = this._terminalId.get()
    if (id !== undefined) this._manager.closeTerminal(id)
    super.dispose()
  }

  private async _respawn(spec: ITerminalEditorRestoreSpec | undefined): Promise<void> {
    if (this.isDisposed) return
    const id = await this._manager.newTerminal({
      target: 'editor',
      ...(spec?.shell !== undefined ? { shell: spec.shell } : {}),
      ...(spec?.cwd !== undefined ? { cwd: spec.cwd } : {}),
    })
    if (id === null) return
    if (this.isDisposed) {
      this._manager.closeTerminal(id)
      return
    }
    this._captureSpec(id)
    this._terminalId.set(id, undefined)
  }

  private _captureSpec(id: string): void {
    const info = this._manager.terminals.get().find((t) => t.id === id)
    if (info) this._shell = info.shell
  }
}
