/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Connectivity probe for the saved-credential gateways shown in the agent
 *  settings panels. Shared by the Claude and Codex config services — a probe is
 *  agent-agnostic: it only proves the gateway's HTTP server answers.
 *--------------------------------------------------------------------------------------------*/

const PROBE_TIMEOUT_MS = 4000

type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  /** Undici keep-alive holds the socket open until the body is consumed/cancelled. */
  body: { cancel(): Promise<void> } | null
}>

/**
 * Resolve `true` when the gateway at `baseUrl` answers with ANY HTTP status —
 * a 401/404 still proves the server is reachable, which is all the status dot
 * claims. `false` on network errors, timeouts, and malformed URLs.
 */
export async function probeGatewayConnectivity(
  baseUrl: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<boolean> {
  try {
    const res = await fetchImpl(baseUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    await res.body?.cancel().catch(() => undefined)
    return true
  } catch {
    return false
  }
}
