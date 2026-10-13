/**
 * Host-side registry backing `chat.registerChatContextProvider`. The
 * candidate space never crosses the wire: a provider surfaces one entry item
 * (label + keywords) to the renderer's `#` popover, and the renderer calls
 * back into `IExtHostChat.$resolveChatContextItem` when the user accepts it —
 * the provider then runs its own picker (typically `window.showQuickPick`) and
 * returns the chosen item.
 */
import type {
  ChatContextItem,
  ChatContextProvider,
  Disposable,
} from '@universe-editor/extension-api'
import type {
  IChatContextItemDto,
  IChatContextResolveContextDto,
  IMainThreadChat,
} from '@universe-editor/extensions-common'

export class HostChatContextRegistry {
  private readonly _providers = new Map<number, ChatContextProvider>()
  private _nextHandle = 1

  constructor(private readonly _mainThread: IMainThreadChat) {}

  registerChatContextProvider(provider: ChatContextProvider): Disposable {
    const handle = this._nextHandle++
    this._providers.set(handle, provider)
    console.info(`[ext-host] chat context provider registered: ${provider.label}`)
    void this._mainThread.$registerChatContextProvider(handle, {
      label: provider.label,
      ...(provider.description !== undefined ? { description: provider.description } : {}),
      ...(provider.iconId !== undefined ? { iconId: provider.iconId } : {}),
      // `keywords` is required by the types, but a JS extension can omit it —
      // treat that as "match on the label only" instead of failing activation.
      keywords: [...(provider.keywords ?? [])],
    })
    return { dispose: () => this._unregister(handle) }
  }

  /** IExtHostChat.$resolveChatContextItem */
  async resolve(
    handle: number,
    query: string,
    context?: IChatContextResolveContextDto,
  ): Promise<IChatContextItemDto | undefined> {
    const provider = this._providers.get(handle)
    if (!provider) {
      console.warn(`[ext-host] $resolveChatContextItem for unregistered provider: ${handle}`)
      return undefined
    }
    const item: ChatContextItem | undefined = await provider.resolve(query, context ?? {})
    if (!item) return undefined
    return { label: item.label, text: item.text }
  }

  dispose(): void {
    for (const handle of [...this._providers.keys()]) {
      this._unregister(handle)
    }
  }

  private _unregister(handle: number): void {
    if (!this._providers.delete(handle)) return
    void this._mainThread.$unregisterChatContextProvider(handle)
  }
}
