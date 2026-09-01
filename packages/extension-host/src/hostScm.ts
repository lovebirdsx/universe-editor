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
  SourceControlResourceGroupOptions,
  SourceControlResourceState,
  SourceControlSupplementaryDecoration,
  SourceControlWorkingTreeScanEntry,
} from '@universe-editor/extension-api'
import type {
  IMainThreadScm,
  ISourceControlResourceStateDto,
  ISupplementaryDecorationDeltaDto,
} from '@universe-editor/extensions-common'
import { toCommandDto, type CommandWireField } from './hostHandles.js'

/**
 * The SCM view executes wire commands directly — explicit `arguments` win over
 * the resource row itself (p4's shelved rows carry the changelist + depot
 * path), so the full command shape crosses, unlike tree rows.
 */
const SCM_COMMAND_WIRE_FIELDS: readonly CommandWireField[] = ['disabled', 'icon', 'arguments']

function toResourceStateDto(state: SourceControlResourceState): ISourceControlResourceStateDto {
  return {
    resourceUri: state.resourceUri,
    ...(state.contextValue !== undefined ? { contextValue: state.contextValue } : {}),
    ...(state.command !== undefined
      ? { command: toCommandDto(state.command, SCM_COMMAND_WIRE_FIELDS) }
      : {}),
    ...(state.decorations !== undefined ? { decorations: { ...state.decorations } } : {}),
  }
}

/**
 * Diff two supplementary-decoration sets into the minimal wire delta. Additions
 * and changes carry the new values; removals carry `description: null`. Returns
 * an empty array when nothing moved, which the caller uses to skip the RPC
 * entirely — providers re-set the whole set on every background scan, and a
 * steady state must cost nothing.
 *
 * Removals come first: the renderer applies the delta in order under its own
 * (case-insensitive) path key, so if a provider reports the same file with
 * different casing across two scans, an add-then-remove pair would cancel out
 * the entry that should have survived.
 *
 * Exported for unit tests.
 */
export function diffSupplementaryDecorations(
  prev: ReadonlyMap<string, SourceControlSupplementaryDecoration>,
  next: ReadonlyMap<string, SourceControlSupplementaryDecoration>,
): ISupplementaryDecorationDeltaDto[] {
  const deltas: ISupplementaryDecorationDeltaDto[] = []
  for (const [key, deco] of prev) {
    if (!next.has(key)) deltas.push({ resourceUri: deco.resourceUri, description: null })
  }
  for (const [key, deco] of next) {
    const before = prev.get(key)
    if (before?.description === deco.description && before.tooltip === deco.tooltip) continue
    deltas.push({
      resourceUri: deco.resourceUri,
      description: deco.description,
      ...(deco.tooltip !== undefined ? { tooltip: deco.tooltip } : {}),
    })
  }
  return deltas
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
    readonly parentId: string | undefined,
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
  private _headRevision: string | undefined
  private _acceptInputCommand: Command | undefined
  private _acceptInputActions: Command[] | undefined
  private readonly _groups = new Set<HostResourceGroup>()
  /** Last set pushed to the renderer, keyed by `resourceUri`, for diffing. */
  private _supplementary = new Map<string, SourceControlSupplementaryDecoration>()

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

  get headRevision(): string | undefined {
    return this._headRevision
  }
  set headRevision(value: string | undefined) {
    this._headRevision = value
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

  createResourceGroup(
    id: string,
    label: string,
    options?: SourceControlResourceGroupOptions,
  ): SourceControlResourceGroup {
    const handle = this._allocateHandle()
    const parentId = options?.parentId
    const group = new HostResourceGroup(handle, id, label, parentId, this._scm, () => {
      this._groups.delete(group)
    })
    this._groups.add(group)
    void this._scm.$registerGroup(this._handle, handle, id, label, parentId)
    return group
  }

  setSupplementaryDecorations(decorations: readonly SourceControlSupplementaryDecoration[]): void {
    // Last entry wins on a duplicated path, matching resourceStates semantics.
    const next = new Map(decorations.map((d) => [d.resourceUri, d]))
    const deltas = diffSupplementaryDecorations(this._supplementary, next)
    this._supplementary = next
    if (deltas.length === 0) return
    void this._scm.$updateSupplementaryDecorations(this._handle, deltas)
  }

  publishWorkingTreeScan(entries: readonly SourceControlWorkingTreeScanEntry[]): void {
    if (entries.length === 0) return
    void this._scm.$publishWorkingTreeScan(
      this._handle,
      entries.map((entry) => ({
        directory: entry.directory,
        hints: entry.changes.map((change) => ({ ...change })),
      })),
    )
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
      // Always send (null when cleared): an omitted key can't clear the
      // renderer's stale HEAD, so a provider that stops reporting (or empties)
      // would otherwise leave the renderer believing the old HEAD still stands.
      headRevision: this._headRevision ?? null,
      ...(this._acceptInputCommand !== undefined
        ? { acceptInputCommand: toCommandDto(this._acceptInputCommand, SCM_COMMAND_WIRE_FIELDS) }
        : {}),
      // Always send the actions (empty array when cleared): an omitted key can't
      // clear the renderer's stale split-button set, so a commit that flips this
      // back to "no actions" would otherwise leave the button showing Commit
      // instead of collapsing to the single Push button.
      acceptInputActions: (this._acceptInputActions ?? []).map((cmd) =>
        toCommandDto(cmd, SCM_COMMAND_WIRE_FIELDS),
      ),
    })
  }
}
