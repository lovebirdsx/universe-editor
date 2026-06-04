import { autorun, EditorInput, URI } from '@universe-editor/platform'
import { ITerminalManagerService } from '../terminal/TerminalManagerService.js'

export class TerminalEditorInput extends EditorInput {
  static readonly TYPE_ID = 'terminal.editor'

  private readonly _resource: URI
  private _label: string

  constructor(
    readonly terminalId: string,
    initialLabel: string,
    @ITerminalManagerService private readonly _manager: ITerminalManagerService,
  ) {
    super()
    this._resource = URI.from({ scheme: 'universe', path: `/terminal/${terminalId}` })
    this._label = initialLabel

    this._register(
      autorun((r) => {
        const info = this._manager.terminals.read(r).find((t) => t.id === terminalId)
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

  override dispose(): void {
    this._manager.closeTerminal(this.terminalId)
    super.dispose()
  }
}
