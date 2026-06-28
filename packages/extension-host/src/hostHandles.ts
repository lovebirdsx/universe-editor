/**
 * Host-side handle objects returned to extensions: status-bar items, output
 * channels, text editors and decoration types. Each wraps an allocated handle
 * and forwards mutations to the renderer's MainThread* services over RPC. Split
 * out of extensionService.ts so the service can stay a thin facade.
 */
import {
  type DecorationRenderOptions,
  type OutputChannel,
  type Range,
  type Selection,
  type StatusBarAlignment,
  type StatusBarItem,
  type TextDocument,
  type TextEditor,
  type TextEditorDecorationType,
  type TextEditorEdit,
} from '@universe-editor/extension-api'
import {
  type IDecorationRangeDto,
  type IDecorationRenderOptionsDto,
  type IMainThreadEditor,
  type IMainThreadOutput,
  type IMainThreadWindow,
  type ISelectionDto,
  type ITextEditDto,
  type OverviewRulerLaneDto,
} from '@universe-editor/extensions-common'

export function toSelectionDto(sel: Selection): ISelectionDto {
  return { anchor: sel.anchor, active: sel.active }
}

export function toDecorationOptionsDto(
  options: DecorationRenderOptions,
): IDecorationRenderOptionsDto {
  return {
    ...(options.gutterIconPath !== undefined ? { gutterIconPath: options.gutterIconPath } : {}),
    ...(options.isWholeLine !== undefined ? { isWholeLine: options.isWholeLine } : {}),
    ...(options.backgroundColor !== undefined ? { backgroundColor: options.backgroundColor } : {}),
    ...(options.borderColor !== undefined ? { borderColor: options.borderColor } : {}),
    ...(options.borderWidth !== undefined ? { borderWidth: options.borderWidth } : {}),
    ...(options.overviewRulerColor !== undefined
      ? { overviewRulerColor: options.overviewRulerColor }
      : {}),
    ...(options.overviewRulerLane !== undefined
      ? { overviewRulerLane: options.overviewRulerLane as OverviewRulerLaneDto }
      : {}),
  }
}

/**
 * Host-side StatusBarItem. Mutations are pushed to the renderer only while the
 * item is shown; hiding/disposing removes its renderer entry. Keyed by `handle`.
 */
export class HostStatusBarItem implements StatusBarItem {
  private _text = ''
  private _tooltip: string | undefined
  private _command: string | undefined
  private _showProgress: boolean | 'spinning' | 'syncing' | undefined
  private _visible = false

  constructor(
    private readonly _handle: number,
    readonly alignment: StatusBarAlignment,
    readonly priority: number,
    private readonly _window: IMainThreadWindow,
  ) {}

  get text(): string {
    return this._text
  }
  set text(value: string) {
    this._text = value
    this._sync()
  }
  get tooltip(): string | undefined {
    return this._tooltip
  }
  set tooltip(value: string | undefined) {
    this._tooltip = value
    this._sync()
  }
  get command(): string | undefined {
    return this._command
  }
  set command(value: string | undefined) {
    this._command = value
    this._sync()
  }
  get showProgress(): boolean | 'spinning' | 'syncing' | undefined {
    return this._showProgress
  }
  set showProgress(value: boolean | 'spinning' | 'syncing' | undefined) {
    this._showProgress = value
    this._sync()
  }

  show(): void {
    this._visible = true
    this._sync()
  }
  hide(): void {
    this._visible = false
    void this._window.$disposeStatusBarEntry(this._handle)
  }
  dispose(): void {
    this.hide()
  }

  private _sync(): void {
    if (!this._visible) return
    void this._window.$setStatusBarEntry(this._handle, {
      text: this._text,
      alignment: this.alignment,
      priority: this.priority,
      ...(this._tooltip !== undefined ? { tooltip: this._tooltip } : {}),
      ...(this._command !== undefined ? { command: this._command } : {}),
      ...(this._showProgress !== undefined ? { showProgress: this._showProgress } : {}),
    })
  }
}

/**
 * Host-side OutputChannel. Delegates append/clear/show/dispose over RPC to the
 * renderer's MainThreadOutput, which owns the real IOutputChannel instance.
 */
export class HostOutputChannel implements OutputChannel {
  constructor(
    private readonly _handle: number,
    readonly name: string,
    private readonly _output: IMainThreadOutput,
  ) {}

  append(text: string): void {
    void this._output.$append(this._handle, text)
  }

  appendLine(text: string): void {
    void this._output.$append(this._handle, `${text}\n`)
  }

  clear(): void {
    void this._output.$clearOutputChannel(this._handle)
  }

  show(): void {
    void this._output.$showOutputChannel(this._handle)
  }

  dispose(): void {
    void this._output.$disposeOutputChannel(this._handle)
  }
}

/**
 * Host-side TextEditor handle. A snapshot of the editor at fetch time (document +
 * selections frozen); `edit` and `setSelections` drive the live editor over RPC.
 * An edit carries the snapshot's version so the renderer can reject it if the
 * document moved on, mirroring VSCode's optimistic-edit contract.
 */
export class HostTextEditor implements TextEditor {
  constructor(
    readonly document: TextDocument,
    readonly selections: readonly Selection[],
    private readonly _version: number,
    private readonly _editorRpc: IMainThreadEditor,
  ) {}

  get selection(): Selection {
    return this.selections[0]!
  }

  edit(callback: (editBuilder: TextEditorEdit) => void): Promise<boolean> {
    const edits: ITextEditDto[] = []
    const builder: TextEditorEdit = {
      replace: (range, text) => edits.push({ range, text }),
      insert: (position, text) => edits.push({ range: { start: position, end: position }, text }),
      delete: (range) => edits.push({ range, text: '' }),
    }
    callback(builder)
    return this._editorRpc.$applyEdits(this.document.uri, this._version, edits)
  }

  setSelections(selections: readonly Selection[]): Promise<void> {
    return this._editorRpc.$setSelections(this.document.uri, selections.map(toSelectionDto))
  }

  setDecorations(decorationType: TextEditorDecorationType, ranges: readonly Range[]): void {
    const dtos: IDecorationRangeDto[] = ranges.map((range) => ({ range }))
    void this._editorRpc.$setDecorations(this.document.uri, decorationType.key, dtos)
  }
}

/**
 * Host-side decoration type. Allocates a handle, ships the static look to the
 * renderer once, and forwards disposal so the renderer drops the CSS rule and
 * every range it painted.
 */
export class HostTextEditorDecorationType implements TextEditorDecorationType {
  private _disposed = false

  constructor(
    readonly key: number,
    private readonly _editorRpc: IMainThreadEditor,
  ) {}

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    void this._editorRpc.$disposeDecorationType(this.key)
  }
}
