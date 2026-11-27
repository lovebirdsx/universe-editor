/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Per-window record of remote-ssh authorities whose bring-up THIS window
 *  initiated (the local Connect to Host / WSL flow: connect → open remote
 *  folder). Connection state is app-global — main broadcasts it to every
 *  renderer — so the status bar uses this per-renderer intent set to tell
 *  "our bring-up" from another window's. Remote windows need no intent: their
 *  workspace folder / argv authority already drives the indicator. Retry does
 *  not record an intent because main's retryConnection returns synchronously,
 *  before the in-flight events arrive, so a finally-scoped intent would never
 *  be visible.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, createDecorator, normalizeRemoteAuthority } from '@universe-editor/platform'

export interface IRemoteConnectIntentService {
  readonly _serviceBrand: undefined
  /** Record that this window started a bring-up for `authority`. */
  begin(authority: string): void
  /** Forget the intent once this window's connect flow settles. */
  end(authority: string): void
  has(authority: string): boolean
}

export const IRemoteConnectIntentService = createDecorator<IRemoteConnectIntentService>(
  'remoteConnectIntentService',
)

export class RemoteConnectIntentService extends Disposable implements IRemoteConnectIntentService {
  declare readonly _serviceBrand: undefined

  private readonly _authorities = new Set<string>()

  begin(authority: string): void {
    this._authorities.add(normalizeRemoteAuthority(authority))
  }

  end(authority: string): void {
    this._authorities.delete(normalizeRemoteAuthority(authority))
  }

  has(authority: string): boolean {
    return this._authorities.has(normalizeRemoteAuthority(authority))
  }
}
