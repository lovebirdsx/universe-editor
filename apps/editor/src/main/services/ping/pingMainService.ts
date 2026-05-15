/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Demo / smoke-test ping service.
 *--------------------------------------------------------------------------------------------*/

import type { IPingService, PingResult } from '../../../shared/ipc/services.js'

export class MainPingService implements IPingService {
  declare readonly _serviceBrand: undefined

  constructor(private readonly _now: () => number = Date.now) {}

  ping(rendererSentAt: number): Promise<PingResult> {
    return Promise.resolve({
      pong: true,
      rendererSentAt,
      mainReceivedAt: this._now(),
    })
  }
}
