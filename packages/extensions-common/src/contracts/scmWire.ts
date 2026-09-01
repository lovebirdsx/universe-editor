/**
 * SCM wire contract shared by the three processes. The extension host owns the
 * authoritative model (created via the `scm` API); it pushes it to the renderer's
 * built-in SCM view over `mainThreadScm`, and the renderer reports user edits to
 * the commit box back over `extHostScm`.
 *
 * Source controls and groups are keyed by host-allocated, globally-unique
 * handles so updates and disposals address a single object. Resource `Uri`s are
 * serialized as filesystem-path strings; `Command`s as `{command,title,args}`.
 */

import type { WorkingTreeChangeDto } from './dirtyDiff.js'

/** Serialized `Command` reference. */
export interface ICommandDto {
  command: string
  title: string
  tooltip?: string
  disabled?: boolean
  icon?: string
  arguments?: unknown[]
}

export interface ISourceControlResourceDecorationsDto {
  strikeThrough?: boolean
  faded?: boolean
  tooltip?: string
  color?: string
  iconPath?: string
}

export interface ISourceControlResourceStateDto {
  resourceUri: string
  contextValue?: string
  command?: ICommandDto
  decorations?: ISourceControlResourceDecorationsDto
}

/** Mutable provider-level features pushed on change. */
export interface ISourceControlFeaturesDto {
  count?: number
  commitTemplate?: string
  /**
   * The commit the provider's HEAD currently points to. `null` means the
   * provider reports no HEAD (empty repo / never set). Consumers can use it to
   * tell whether any file's HEAD content could have changed: `git show
   * HEAD:<path>` is fully determined by `(HEAD commit, path)`, so when this
   * value is unchanged a provider's cached HEAD content is still valid.
   * Always sent (even `null`) so a transition back to "no HEAD" clears it.
   */
  headRevision?: string | null
  acceptInputCommand?: ICommandDto
  /** Commit-bar actions (primary first); drives the split commit button. */
  acceptInputActions?: ICommandDto[]
}

/** Mutable group-level features pushed on change. */
export interface ISourceControlGroupFeaturesDto {
  label?: string
  hideWhenEmpty?: boolean
}

/**
 * One change to the provider's supplementary decorations (server-side condition
 * of a file: behind / held by someone else). The extension side sets whole sets;
 * the host diffs them so a steady state sends nothing.
 *
 * `description: null` means "remove this file's decoration" — a distinct value
 * rather than an omitted key, because ProxyChannel strips trailing `undefined`
 * and a middle `undefined` becomes `null` in JSON anyway.
 */
export interface ISupplementaryDecorationDeltaDto {
  resourceUri: string
  description: string | null
  tooltip?: string
}

/**
 * One directory batch of a provider's background working-tree scan (p4's dry-run
 * `reconcile -n` walk). The provider pushes these as the scan progresses — each
 * entry says "this directory was scanned and these changes were found under it".
 * There is no negative entry: an empty `hints` array carries no information the
 * renderer acts on, it is the absence of a non-empty entry that reads as clean.
 * Directory-level on purpose: the renderer folds file hints up into folder tints
 * before any file row is rendered, which is exactly what a file-level channel
 * cannot express.
 */
export interface IWorkingTreeScanEntryDto {
  /** Local directory the scan covered (host-side path). */
  readonly directory: string
  /** Changes found under it; empty = nothing found (not a clear). */
  readonly hints: readonly WorkingTreeChangeDto[]
}

/**
 * Renderer ← host: the SCM model feeding the built-in view. The host's
 * ChannelClient calls these on the renderer's ChannelServer.
 */
export interface IMainThreadScm {
  $registerSourceControl(handle: number, id: string, label: string, rootUri?: string): Promise<void>
  $updateSourceControl(handle: number, features: ISourceControlFeaturesDto): Promise<void>
  $unregisterSourceControl(handle: number): Promise<void>
  $registerGroup(
    sourceControlHandle: number,
    groupHandle: number,
    id: string,
    label: string,
    parentId?: string,
  ): Promise<void>
  $updateGroup(groupHandle: number, features: ISourceControlGroupFeaturesDto): Promise<void>
  $updateGroupResourceStates(
    groupHandle: number,
    resources: ISourceControlResourceStateDto[],
  ): Promise<void>
  $unregisterGroup(groupHandle: number): Promise<void>
  /** Apply supplementary-decoration changes; never called with an empty delta. */
  $updateSupplementaryDecorations(
    sourceControlHandle: number,
    deltas: ISupplementaryDecorationDeltaDto[],
  ): Promise<void>
  /**
   * Apply one batch of the provider's background working-tree scan. Unlike
   * resource groups and supplementary decorations, this is not whole-set state:
   * entries accumulate (merge) as the scan progresses, keyed by the provider
   * that published them. A clean directory contributes no entry at all, so an
   * earlier batch's hints for that directory are only superseded by a later
   * non-empty batch — the renderer never infers "clean" from an empty batch.
   */
  $publishWorkingTreeScan(
    sourceControlHandle: number,
    entries: IWorkingTreeScanEntryDto[],
  ): Promise<void>
  $setInputBoxValue(sourceControlHandle: number, value: string): Promise<void>
  $setInputBoxPlaceholder(sourceControlHandle: number, placeholder: string): Promise<void>
}

/**
 * Host ← renderer: user interactions in the SCM view. The renderer's
 * ChannelClient calls these on the host's ChannelServer.
 */
export interface IExtHostScm {
  /** The user edited the commit box; update the host's `inputBox.value`. */
  $onInputBoxValueChange(sourceControlHandle: number, value: string): Promise<void>
}
