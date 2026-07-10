/**
 * Host-side SCM objects backing the `scm` API. Each mirrors its state to the
 * renderer's built-in SCM view over `IMainThreadScm`, addressed by a globally
 * unique handle the host allocates. The renderer reports commit-box edits back
 * through `ExtensionService.onInputBoxValueChange`, which calls
 * `HostInputBox.acceptRendererValue` so the extension sees the new value without
 * the host echoing it straight back.
 */
import { Emitter, type Event } from '@universe-editor/platform'
import type {
  Command,
  SourceControl,
  SourceControlInputBox,
  SourceControlResourceGroup,
  SourceControlResourceState,
} from '@universe-editor/extension-api'
import type {
  ICommandDto,
  IMainThreadScm,
  ISourceControlResourceStateDto,
} from '@universe-editor/extensions-common'

function toCommandDto(cmd: Command): ICommandDto {
  return {
    command: cmd.command,
    title: cmd.title,
    ...(cmd.tooltip !== undefined ? { tooltip: cmd.tooltip } : {}),
    ...(cmd.disabled !== undefined ? { disabled: cmd.disabled } : {}),
    ...(cmd.icon !== undefined ? { icon: cmd.icon } : {}),
    ...(cmd.arguments !== undefined ? { arguments: cmd.arguments } : {}),
  }
}

function toResourceStateDto(state: SourceControlResourceState): ISourceControlResourceStateDto {
  return {
    resourceUri: state.resourceUri,
    ...(state.contextValue !== undefined ? { contextValue: state.contextValue } : {}),
    ...(state.command !== undefined ? { command: toCommandDto(state.command) } : {}),
    ...(state.decorations !== undefined ? { decorations: { ...state.decorations } } : {}),
  }
}

class HostInputBox implements SourceControlInputBox {
  private _value = ''
  private _placeholder = ''
  private readonly _onDidChange = new Emitter<string>()
  readonly onDidChange: Event<string> = this._onDidChange.event

  constructor(
    private readonly _handle: number,
    private readonly _scm: IMainThreadScm,
  ) {}

  get value(): string {
    return this._value
  }
  set value(value: string) {
    this._value = value
    void this._scm.$setInputBoxValue(this._handle, value)
  }

  get placeholder(): string {
    return this._placeholder
  }
  set placeholder(value: string) {
    this._placeholder = value
    void this._scm.$setInputBoxPlaceholder(this._handle, value)
  }

  /** A renderer edit: store it and notify the extension, but do not echo back. */
  acceptRendererValue(value: string): void {
    this._value = value
    this._onDidChange.fire(value)
  }

  dispose(): void {
    this._onDidChange.dispose()
  }
}

class HostResourceGroup implements SourceControlResourceGroup {
  private _label: string
  private _hideWhenEmpty: boolean | undefined
  private _resourceStates: SourceControlResourceState[] = []

  constructor(
    private readonly _handle: number,
    readonly id: string,
    label: string,
    private readonly _scm: IMainThreadScm,
    private readonly _onDispose: () => void,
  ) {
    this._label = label
  }

  get label(): string {
    return this._label
  }
  set label(value: string) {
    this._label = value
    void this._scm.$updateGroup(this._handle, { label: value })
  }

  get hideWhenEmpty(): boolean | undefined {
    return this._hideWhenEmpty
  }
  set hideWhenEmpty(value: boolean | undefined) {
    this._hideWhenEmpty = value
    void this._scm.$updateGroup(this._handle, value !== undefined ? { hideWhenEmpty: value } : {})
  }

  get resourceStates(): SourceControlResourceState[] {
    return this._resourceStates
  }
  set resourceStates(states: SourceControlResourceState[]) {
    this._resourceStates = states
    void this._scm.$updateGroupResourceStates(this._handle, states.map(toResourceStateDto))
  }

  dispose(): void {
    void this._scm.$unregisterGroup(this._handle)
    this._onDispose()
  }
}

export class HostSourceControl implements SourceControl {
  readonly inputBox: HostInputBox
  private _count: number | undefined
  private _commitTemplate: string | undefined
  private _acceptInputCommand: Command | undefined
  private _acceptInputActions: Command[] | undefined
  private readonly _groups = new Set<HostResourceGroup>()

  constructor(
    private readonly _handle: number,
    readonly id: string,
    readonly label: string,
    readonly rootUri: string | undefined,
    private readonly _scm: IMainThreadScm,
    private readonly _allocateHandle: () => number,
    private readonly _onDispose: () => void,
  ) {
    this.inputBox = new HostInputBox(_handle, _scm)
  }

  get count(): number | undefined {
    return this._count
  }
  set count(value: number | undefined) {
    this._count = value
    this._updateFeatures()
  }

  get commitTemplate(): string | undefined {
    return this._commitTemplate
  }
  set commitTemplate(value: string | undefined) {
    this._commitTemplate = value
    this._updateFeatures()
  }

  get acceptInputCommand(): Command | undefined {
    return this._acceptInputCommand
  }
  set acceptInputCommand(value: Command | undefined) {
    this._acceptInputCommand = value
    this._updateFeatures()
  }

  get acceptInputActions(): Command[] | undefined {
    return this._acceptInputActions
  }
  set acceptInputActions(value: Command[] | undefined) {
    this._acceptInputActions = value
    this._updateFeatures()
  }

  createResourceGroup(id: string, label: string): SourceControlResourceGroup {
    const handle = this._allocateHandle()
    const group = new HostResourceGroup(handle, id, label, this._scm, () => {
      this._groups.delete(group)
    })
    this._groups.add(group)
    void this._scm.$registerGroup(this._handle, handle, id, label)
    return group
  }

  dispose(): void {
    for (const group of [...this._groups]) group.dispose()
    this.inputBox.dispose()
    void this._scm.$unregisterSourceControl(this._handle)
    this._onDispose()
  }

  private _updateFeatures(): void {
    void this._scm.$updateSourceControl(this._handle, {
      ...(this._count !== undefined ? { count: this._count } : {}),
      ...(this._commitTemplate !== undefined ? { commitTemplate: this._commitTemplate } : {}),
      ...(this._acceptInputCommand !== undefined
        ? { acceptInputCommand: toCommandDto(this._acceptInputCommand) }
        : {}),
      ...(this._acceptInputActions !== undefined
        ? { acceptInputActions: this._acceptInputActions.map(toCommandDto) }
        : {}),
    })
  }
}
