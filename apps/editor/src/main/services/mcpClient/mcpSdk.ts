/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The single import surface for the MCP SDK's client side.
 *
 *  The SDK's `exports` map declares `./client` explicitly and leaves every other
 *  subpath to a `"./*"` wildcard whose `types` condition is `dist/esm/*.d.ts`.
 *  TypeScript still resolves `.../client/streamableHttp.js` — it substitutes the
 *  `.d.ts` extension when the declared path misses — but **Node requires the `.js`
 *  spelling** (wildcard mapping never adds an extension) and the root entry
 *  (`@modelcontextprotocol/sdk`) is never imported at all: its `exports["."]` points
 *  at a `dist/esm/index.js` the tarball does not ship, so it fails at runtime.
 *  Keep every SDK import inside this file so a future packaging change has one
 *  place to break.
 *--------------------------------------------------------------------------------------------*/

import { Client } from '@modelcontextprotocol/sdk/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'

/**
 * The SDK's `Transport` interface, recovered from `Client.connect` instead of
 * importing `shared/transport` — that subpath hits the same exports gap.
 */
export type McpTransport = Parameters<Client['connect']>[0]

/** A JSON-RPC message on the wire, recovered the same way. */
export type McpJsonRpcMessage = Parameters<McpTransport['send']>[0]

/**
 * Build one of the SDK's HTTP transports (stdio is hand-rolled elsewhere).
 *
 * The cast is a compiler-flag mismatch, not a shape difference: the SDK ships
 * declarations built without `exactOptionalPropertyTypes`, so its own
 * `sessionId: string | undefined` fails to satisfy its own optional
 * `sessionId?: string`. Confined here so no other file needs the cast.
 */
export function createHttpTransport(
  kind: 'http' | 'sse',
  url: string,
  headers?: Readonly<Record<string, string>>,
): McpTransport {
  const target = new URL(url)
  const options = headers !== undefined ? { requestInit: { headers: { ...headers } } } : undefined
  const transport =
    kind === 'http'
      ? new StreamableHTTPClientTransport(target, options)
      : new SSEClientTransport(target, options)
  return transport as McpTransport
}

export { Client, ErrorCode, McpError, UnauthorizedError }
