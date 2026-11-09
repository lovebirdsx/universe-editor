import { MOBILE_HEALTH_PATH, MOBILE_PROTOCOL_VERSION } from '@universe-editor/mobile-protocol'

/**
 * HTTP-level verdict about the gateway the phone is pointed at. A `ws` failure
 * looks identical from the socket (close code 1006) whether the TCP connection
 * never left the phone or the TLS/upgrade was rejected, so the UI probes the
 * same origin over plain HTTP to split those cases.
 */
export type ConnectionDiagnosisKind =
  | 'ok'
  | 'forbidden'
  | 'not-found'
  | 'http-error'
  | 'invalid-response'
  | 'network-error'
  | 'protocol-mismatch'

export interface ConnectionDiagnosis {
  readonly kind: ConnectionDiagnosisKind
  readonly origin: string
  readonly status?: number
  readonly serverVersion?: string
  readonly protocolVersion?: number
}

export interface HealthProbeOptions {
  readonly fetchImpl?: typeof fetch | undefined
  readonly timeoutMs?: number | undefined
}

export const HEALTH_PROBE_TIMEOUT_MS = 3_000

export async function probeGatewayHealth(
  origin: string,
  options: HealthProbeOptions = {},
): Promise<ConnectionDiagnosis> {
  const base = origin.replace(/\/+$/u, '')
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const controller = new AbortController()
  const timeout = globalThis.setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS,
  )
  try {
    const response = await fetchImpl(`${base}${MOBILE_HEALTH_PATH}`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    })
    if (response.status === 403) return { kind: 'forbidden', origin: base, status: 403 }
    if (response.status === 404) return { kind: 'not-found', origin: base, status: 404 }
    if (!response.ok) return { kind: 'http-error', origin: base, status: response.status }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      return { kind: 'invalid-response', origin: base, status: response.status }
    }
    const record =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : undefined
    const protocolVersion = record?.['protocolVersion']
    if (record?.['status'] !== 'ok' || typeof protocolVersion !== 'number') {
      return { kind: 'invalid-response', origin: base, status: response.status }
    }
    if (protocolVersion !== MOBILE_PROTOCOL_VERSION) {
      return { kind: 'protocol-mismatch', origin: base, status: response.status, protocolVersion }
    }
    const serverVersion = record['serverVersion']
    return {
      kind: 'ok',
      origin: base,
      status: response.status,
      protocolVersion,
      ...(typeof serverVersion === 'string' ? { serverVersion } : {}),
    }
  } catch {
    // A timeout aborts the fetch; from the user's point of view that is the
    // same as an unreachable gateway.
    return { kind: 'network-error', origin: base }
  } finally {
    globalThis.clearTimeout(timeout)
  }
}
