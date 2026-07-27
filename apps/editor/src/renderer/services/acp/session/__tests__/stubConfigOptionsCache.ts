/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Test stub for IAcpConfigOptionsCacheService — in-memory per-agent bag store
 *  with no persistence. Lets AcpSessionService tests construct the service and
 *  assert the optimistic-seed write-back path without the storage machinery.
 *--------------------------------------------------------------------------------------------*/

import { observableValue, type IObservable } from '@universe-editor/platform'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import type { IAcpConfigOptionsCacheService } from '../acpConfigOptionsCache.js'

export class StubConfigOptionsCache implements IAcpConfigOptionsCacheService {
  declare readonly _serviceBrand: undefined
  readonly store = new Map<string, readonly SessionConfigOption[]>()
  readonly cache: IObservable<Readonly<Record<string, readonly SessionConfigOption[]>>> =
    observableValue('test.configOptionsCache', {})
  initialize(): Promise<void> {
    return Promise.resolve()
  }
  get(agentId: string): readonly SessionConfigOption[] {
    return this.store.get(agentId) ?? []
  }
  set(agentId: string, bag: readonly SessionConfigOption[]): void {
    this.store.set(agentId, bag)
  }
}
