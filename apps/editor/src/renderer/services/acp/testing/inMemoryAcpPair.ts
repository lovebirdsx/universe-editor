/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  In-memory paired ACP streams for unit tests. Each side gets a SDK `Stream`
 *  whose writable feeds straight into the other side's readable — no
 *  newline-delimited encoding, no real subprocess. Tests can plug one side
 *  into `ClientSideConnection` and the other into `AgentSideConnection`
 *  (typically backed by a fake `Agent` implementation).
 *--------------------------------------------------------------------------------------------*/

import type { AnyMessage, Stream } from '@agentclientprotocol/sdk'

export interface InMemoryAcpPair {
  readonly clientStream: Stream
  readonly agentStream: Stream
}

/**
 * Create a pair of duplex streams that loop messages between two ACP peers.
 *
 * `clientStream.writable` is piped to `agentStream.readable` and vice versa.
 * Both sides see the original object references (no JSON round-trip), so tests
 * stay decoupled from wire format.
 */
export function createInMemoryAcpPair(): InMemoryAcpPair {
  const clientToAgent = new TransformStream<AnyMessage, AnyMessage>()
  const agentToClient = new TransformStream<AnyMessage, AnyMessage>()
  return {
    clientStream: {
      writable: clientToAgent.writable,
      readable: agentToClient.readable,
    },
    agentStream: {
      writable: agentToClient.writable,
      readable: clientToAgent.readable,
    },
  }
}
