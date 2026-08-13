/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Client side of the remote-tunnel connection handshake. On a freshly opened TCP
 *  socket we write one JSON Control frame describing the connection, then read the
 *  server's single Control-frame response. The residual bytes (received after the
 *  response frame) MUST be handed to the successor PersistentProtocol synchronously
 *  (see handshake.ts) — this module returns them to the caller for that purpose.
 *--------------------------------------------------------------------------------------------*/

import {
  REMOTE_PROTOCOL_VERSION,
  RemoteConnectionErrorCode,
  decodeControlJson,
  encodeControlJson,
  readFirstControlFrame,
  writeControlFrame,
  type IRemoteConnectionRequest,
  type IRemoteConnectionResponse,
  type ISocket,
} from '@universe-editor/platform'

const HANDSHAKE_TIMEOUT_MS = 10_000

/** Error carrying a {@link RemoteConnectionErrorCode} so callers can branch. */
export interface RemoteHandshakeError extends Error {
  readonly code: RemoteConnectionErrorCode
}

export interface ClientHandshakeResult {
  /** Bytes received after the response frame; feed to PersistentProtocol verbatim. */
  readonly residual: Uint8Array
}

export async function performClientHandshake(
  socket: ISocket,
  req: Omit<IRemoteConnectionRequest, 'type' | 'protocolVersion'>,
): Promise<ClientHandshakeResult> {
  const request: IRemoteConnectionRequest = {
    type: 'connect',
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    ...req,
  }
  writeControlFrame(socket, encodeControlJson(request))
  const { data, residual } = await readFirstControlFrame(socket, HANDSHAKE_TIMEOUT_MS)
  const response = decodeControlJson<IRemoteConnectionResponse>(data)
  if (response.type === 'ok') {
    return { residual }
  }
  throw Object.assign(new Error(response.message), {
    code: response.code,
  }) as RemoteHandshakeError
}
