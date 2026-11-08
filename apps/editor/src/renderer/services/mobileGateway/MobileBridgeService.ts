/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Reverse mobile channel, renderer side. M1 only proves the channel is wired;
 *  M2 extends this service to project ACP sessions (snapshots/deltas) and route
 *  mobile commands onto the existing session service.
 *--------------------------------------------------------------------------------------------*/

import type { IMobileBridgeService } from '../../../shared/ipc/mobileGatewayService.js'

export class MobileBridgeService implements IMobileBridgeService {
  declare readonly _serviceBrand: undefined

  ping(): Promise<'pong'> {
    return Promise.resolve('pong')
  }
}
