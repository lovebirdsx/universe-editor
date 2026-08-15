/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure state-mapping helpers for the Remote Explorer rows: status-dot styling
 *  and the row's primary (left-click) action. Kept component-free so they run
 *  in the renderer-node test project.
 *--------------------------------------------------------------------------------------------*/

import type { RemoteConnectionStateDto } from '../../../shared/ipc/remoteStatusService.js'

export type RemoteDotState = 'connected' | 'connecting' | 'failed' | 'idle'

export function dotStateOf(state: RemoteConnectionStateDto | undefined): RemoteDotState {
  switch (state) {
    case 'connected':
      return 'connected'
    case 'reconnecting':
    case 'deploying':
    case 'forwarding':
    case 'handshaking':
      return 'connecting'
    case 'failed':
      return 'failed'
    default:
      return 'idle'
  }
}

/**
 * Command id for the row's primary click, or null for in-flight states where a
 * click has no useful effect. An undefined state = a target that has no live
 * connection (idle/disposed connections are never listed), so click = connect.
 */
export function remoteRowPrimaryAction(
  state: RemoteConnectionStateDto | undefined,
): 'remote.connectToHost' | 'remote.openFolder' | 'remote.retryConnection' | null {
  if (state === 'connected') return 'remote.openFolder'
  if (state === 'failed') return 'remote.retryConnection'
  if (
    state === 'reconnecting' ||
    state === 'deploying' ||
    state === 'forwarding' ||
    state === 'handshaking'
  ) {
    return null
  }
  return 'remote.connectToHost'
}
