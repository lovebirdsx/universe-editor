/*---------------------------------------------------------------------------------------------
 *  Renderer-side owner of extension-contributed chat context providers (the
 *  `#` popover in the agent prompt input). Handles the host → renderer
 *  `mainThreadChat` channel: the host announces one *entry* per provider
 *  (label + keywords), the popover lists those entries alongside the built-in
 *  context sources, and accepting one calls back into `extHostChat` so the
 *  extension runs its own picker and returns the final item. The candidate
 *  space therefore never crosses the wire.
 *
 *  Providers vanish with the host (`reset()` on teardown) — that is what gates
 *  the entries on an extension actually being active.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator, Disposable } from '@universe-editor/platform'
import type {
  IChatContextItemDto,
  IChatContextProviderDto,
  IExtHostChat,
  IMainThreadChat,
} from '@universe-editor/extensions-common'

export interface IChatContextProviderEntry {
  readonly handle: number
  readonly provider: IChatContextProviderDto
}

export interface IChatContextService {
  readonly _serviceBrand: undefined
  /** Wire the host proxy once the extension host connection is up. */
  setExtHost(extHost: IExtHostChat): void
  getProviders(): readonly IChatContextProviderEntry[]
  /** Run the provider's own picker host-side and return the accepted item. */
  resolveItem(handle: number, query: string): Promise<IChatContextItemDto | undefined>
  /** Drop every provider (extension host torn down). */
  reset(): void
}

export const IChatContextService = createDecorator<IChatContextService>('chatContextService')

export class ChatContextService extends Disposable implements IChatContextService, IMainThreadChat {
  declare readonly _serviceBrand: undefined

  private readonly _providers = new Map<number, IChatContextProviderDto>()
  private _extHost: IExtHostChat | undefined

  setExtHost(extHost: IExtHostChat): void {
    this._extHost = extHost
  }

  getProviders(): readonly IChatContextProviderEntry[] {
    return [...this._providers].map(([handle, provider]) => ({ handle, provider }))
  }

  async resolveItem(handle: number, query: string): Promise<IChatContextItemDto | undefined> {
    if (!this._providers.has(handle) || !this._extHost) return undefined
    try {
      return await this._extHost.$resolveChatContextItem(handle, query)
    } catch (err) {
      console.warn(
        `[chatContext] $resolveChatContextItem(${handle}) failed: ${(err as Error).message}`,
      )
      return undefined
    }
  }

  reset(): void {
    this._extHost = undefined
    this._providers.clear()
  }

  // --- IMainThreadChat (host → renderer) ---

  $registerChatContextProvider(handle: number, provider: IChatContextProviderDto): Promise<void> {
    console.debug(`[chatContext] provider registered: ${provider.label}`)
    this._providers.set(handle, provider)
    return Promise.resolve()
  }

  $unregisterChatContextProvider(handle: number): Promise<void> {
    if (this._providers.delete(handle)) {
      console.debug(`[chatContext] provider unregistered: ${handle}`)
    }
    return Promise.resolve()
  }
}
