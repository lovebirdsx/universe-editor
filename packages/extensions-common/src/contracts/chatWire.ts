/**
 * Chat-context wire contract shared by the renderer and the extension host.
 *
 * Extensions register `#`-completion providers over `mainThreadChat`; the
 * renderer pulls one *resolved* item back over `extHostChat` when the user
 * accepts the provider's entry item in the `#` popover.
 *
 * A provider surfaces exactly one entry item (label + keywords) — the actual
 * picking happens extension-side (typically through `window.showQuickPick`),
 * so the renderer never sees the candidate list, only the final item. This
 * mirrors how chat context sources behave in the built-in `#` popover, where a
 * source with an open-ended candidate space (e.g. git commits) is a two-step
 * flow too.
 */

/** A provider registration, pushed to the renderer when an extension registers one. */
export interface IChatContextProviderDto {
  /** Entry-item label shown in the `#` popover (e.g. `Perforce Changelist…`). */
  label: string
  /** Optional secondary text on the entry item. */
  description?: string
  /** Workbench icon id, resolved through the renderer's icon table. */
  iconId?: string
  /**
   * Keywords that surface the entry item in the `#` popover. Matching is a
   * case-insensitive substring test against the typed query, applied to these
   * keywords and to `label`, mirroring the built-in sources; an empty query
   * surfaces every registered provider.
   */
  keywords: readonly string[]
}

/** One resolved context item: the extension has already picked it. */
export interface IChatContextItemDto {
  /** Pill text inserted into the input box. */
  label: string
  /**
   * The text-block body sent to the model. Structured information MUST live
   * here: the built-in agents discard `resource_link` names/descriptions/_meta,
   * so anything the model needs to see has to be in this string.
   */
  text: string
}

/**
 * Renderer ← host: provider registrations. The host's ChannelClient calls
 * these on the renderer's ChannelServer.
 */
export interface IMainThreadChat {
  /** `handle` is host-allocated and stable for the provider's lifetime. */
  $registerChatContextProvider(handle: number, provider: IChatContextProviderDto): Promise<void>
  $unregisterChatContextProvider(handle: number): Promise<void>
}

/**
 * Where the session that accepted the entry item is rooted. Lets a provider
 * narrow a workspace-wide candidate space (changelists, changes) to the
 * directory the user is actually working in.
 */
export interface IChatContextResolveContextDto {
  /**
   * Absolute path of the directory this session's prompt input is rooted at —
   * the agent's working directory when the session is scoped to a
   * subdirectory of the open folder, otherwise the folder itself. Undefined
   * when no folder is open. A provider whose candidate source cannot contain
   * it must fall back to its own default scope rather than invent one.
   */
  readonly sessionDir?: string
}

/**
 * Host ← renderer: resolving an accepted entry item into the final context
 * item. The renderer's ChannelClient calls these on the host's ChannelServer.
 */
export interface IExtHostChat {
  /**
   * Run the provider's own picker and return the chosen item, or undefined
   * when the user cancelled. `query` is the fragment the user typed after `#`
   * that matched this provider (one of its keywords, or part of its label).
   */
  $resolveChatContextItem(
    handle: number,
    query: string,
    context?: IChatContextResolveContextDto,
  ): Promise<IChatContextItemDto | undefined>
}
