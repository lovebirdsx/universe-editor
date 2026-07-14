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
