/**
 * Thin HTTP client for the Swarm REST API. Global `fetch` (extension host = Node
 * 20) with Basic auth injected here (never hand-rolled at call sites), retry with
 * backoff on transient failures, AbortSignal-based cancellation, and HTTP status
 * → structured error mapping. Modeled on the AI OpenAI provider's HTTP template.
 *
 * RED LINE: only the URL + status code are logged — never the Authorization
 * header or any credential.
 */

import type { SwarmLogger } from './swarmLog.js'

export enum SwarmErrorCode {
  Unauthorized = 'unauthorized',
  NotFound = 'not-found',
  RateLimited = 'rate-limited',
  Network = 'network',
  Server = 'server',
  Unknown = 'unknown',
}

export class SwarmError extends Error {
  constructor(
    readonly code: SwarmErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'SwarmError'
  }
}

export interface SwarmApiOptions {
  /** Base Swarm URL, e.g. `https://swarm.example.com`. */
  readonly baseUrl: string
  /** API version segment, e.g. `v11`. */
  readonly apiVersion: string
  /** Resolve the current Basic auth header value (lazy so a fresh ticket is used).
   *  Returns undefined when no credential is available (not logged in). */
  readonly getAuth: () => Promise<string | undefined>
  /** Per-request timeout (ms). fetch() has NO usable default timeout (undici's
   *  headersTimeout is ~300s), so a gateway that accepts the connection but
   *  stalls would wedge a notification poll's dashboard fetch for minutes —
   *  and with it the renderer's serialized refresh() latch, silently killing
   *  all later ticks (the "no notifications, foreground included" bug).
   *  `UNIVERSE_SWARM_REQUEST_TIMEOUT_MS` overrides (e2e); default 30s. */
  readonly timeoutMs?: number
  /** Optional structured logger. Receives redacted request lines only (method /
   *  path / status / timing) at info, and full query/body/response at debug. */
  readonly logger?: SwarmLogger
}

interface RequestOptions {
  readonly method?: string
  /** Query parameters; arrays expand to repeated `key[]=v` pairs (Swarm style). */
  readonly query?: Record<string, string | number | boolean | string[] | undefined>
  /** JSON body (sent as application/json). */
  readonly body?: unknown
  readonly signal?: AbortSignal
}

const MAX_ATTEMPTS = 3
const BASE_DELAY_MS = 300
const MAX_DELAY_MS = 5_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** Per-request timeout for Swarm HTTP calls: explicit option wins, then the
 *  `UNIVERSE_SWARM_REQUEST_TIMEOUT_MS` env override (e2e), then the default. */
export function resolveSwarmRequestTimeoutMs(option: number | undefined): number {
  if (option !== undefined && Number.isFinite(option) && option > 0) return Math.floor(option)
  const env = Number(process.env['UNIVERSE_SWARM_REQUEST_TIMEOUT_MS'])
  if (Number.isFinite(env) && env > 0) return Math.floor(env)
  return DEFAULT_REQUEST_TIMEOUT_MS
}

/** Map an HTTP status + detail to a structured SwarmError. */
export function mapHttpError(status: number, detail: string): SwarmError {
  if (status === 401 || status === 403) {
    return new SwarmError(SwarmErrorCode.Unauthorized, `Swarm unauthorized (${status})`, status)
  }
  if (status === 404) {
    return new SwarmError(SwarmErrorCode.NotFound, `Swarm resource not found (${status})`, status)
  }
  if (status === 429) {
    return new SwarmError(SwarmErrorCode.RateLimited, `Swarm rate limited (${status})`, status)
  }
  if (status >= 500) {
    return new SwarmError(
      SwarmErrorCode.Server,
      `Swarm server error (${status}): ${detail}`,
      status,
    )
  }
  return new SwarmError(
    SwarmErrorCode.Unknown,
    `Swarm request failed (${status}): ${detail}`,
    status,
  )
}

function isTransient(err: unknown): boolean {
  if (err instanceof SwarmError) {
    return err.code === SwarmErrorCode.RateLimited || err.code === SwarmErrorCode.Server
  }
  // A raw fetch rejection (network layer) is transient.
  return err instanceof Error && err.name !== 'AbortError'
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const handle = setTimeout(resolve, ms)
    if (signal) {
      const onAbort = () => {
        clearTimeout(handle)
        reject(new SwarmError(SwarmErrorCode.Network, 'aborted'))
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/** Build a query string from a params object, expanding arrays to `key[]=v`. */
export function buildQuery(
  query: Record<string, string | number | boolean | string[] | undefined> | undefined,
): string {
  if (!query) return ''
  const parts: string[] = []
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const v of value) parts.push(`${encodeURIComponent(key)}[]=${encodeURIComponent(v)}`)
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    }
  }
  return parts.length > 0 ? `?${parts.join('&')}` : ''
}

export class SwarmApi {
  private readonly _timeoutMs: number

  constructor(private readonly _opts: SwarmApiOptions) {
    this._timeoutMs = resolveSwarmRequestTimeoutMs(_opts.timeoutMs)
  }

  /** GET a path, returning the decoded JSON. */
  get<T = unknown>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> {
    return this.request<T>(path, { ...options, method: 'GET' })
  }

  /** POST a JSON body, returning the decoded JSON. */
  post<T = unknown>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      ...(body !== undefined ? { body } : {}),
      ...(signal ? { signal } : {}),
    })
  }

  /** PATCH a JSON body, returning the decoded JSON. */
  patch<T = unknown>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>(path, {
      method: 'PATCH',
      ...(body !== undefined ? { body } : {}),
      ...(signal ? { signal } : {}),
    })
  }

  /** Build the absolute URL for an API path (`/reviews` → base/api/vN/reviews).
   *  `UNIVERSE_SWARM_BASE_URL` overrides the configured base (e2e fake server). */
  private _url(path: string, query: RequestOptions['query']): string {
    const override = process.env['UNIVERSE_SWARM_BASE_URL']
    const base = (override && override.trim() ? override : this._opts.baseUrl).replace(/\/+$/, '')
    const version = this._opts.apiVersion.replace(/^\/+|\/+$/g, '')
    const rel = path.replace(/^\/+/, '')
    return `${base}/api/${version}/${rel}${buildQuery(query)}`
  }

  private async request<T>(path: string, options: RequestOptions): Promise<T> {
    const method = options.method ?? 'GET'
    const url = this._url(path, options.query)
    const redacted = redactUrl(url)
    const log = this._opts.logger
    log?.debug('api', `→ ${method} ${redacted}${describeBody(options.body)}`)
    let lastErr: unknown
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (options.signal?.aborted) {
        throw new SwarmError(SwarmErrorCode.Network, 'aborted')
      }
      const startedAt = Date.now()
      try {
        return await this._once<T>(method, url, redacted, options, attempt)
      } catch (err) {
        lastErr = err
        const ms = Date.now() - startedAt
        const willRetry = attempt < MAX_ATTEMPTS - 1 && isTransient(err) && !options.signal?.aborted
        if (!willRetry) {
          log?.error(
            'api',
            `✗ ${method} ${redacted} failed after ${attempt + 1} attempt(s) in ${ms}ms: ${errMessage(err)}`,
          )
          throw err
        }
        const backoff = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt)
        log?.warn(
          'api',
          `⟳ ${method} ${redacted} attempt ${attempt + 1} failed (${errMessage(err)}); retrying in ${backoff}ms`,
        )
        await delay(backoff, options.signal)
      }
    }
    throw lastErr
  }

  private async _once<T>(
    method: string,
    url: string,
    redacted: string,
    options: RequestOptions,
    attempt: number,
  ): Promise<T> {
    const auth = await this._opts.getAuth()
    if (!auth) {
      throw new SwarmError(SwarmErrorCode.Unauthorized, 'no Swarm credential (not logged in)')
    }
    const headers: Record<string, string> = { authorization: auth, accept: 'application/json' }
    let body: string | undefined
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(options.body)
    }
    const startedAt = Date.now()
    let res: Response
    // Compose the caller's cancellation with a per-request timeout: fetch() alone
    // can stall for minutes on a hung gateway (undici's ~300s headersTimeout),
    // which wedges the notification poll's serialized refresh() latch. A caller
    // abort stays non-retryable; a timeout is transient and retried above.
    const timeoutSignal = AbortSignal.timeout(this._timeoutMs)
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
    try {
      res = await fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal,
      })
    } catch (err) {
      // fetch rejects with the signal's reason: a DOMException (not reliably
      // `instanceof Error`) named 'AbortError' for a caller abort or
      // 'TimeoutError' for AbortSignal.timeout — match on the name.
      const name = errorName(err)
      if (name === 'AbortError') {
        throw new SwarmError(SwarmErrorCode.Network, 'aborted')
      }
      if (name === 'TimeoutError') {
        throw new SwarmError(
          SwarmErrorCode.Network,
          `timed out after ${this._timeoutMs}ms: ${method} ${redacted}`,
        )
      }
      throw new SwarmError(SwarmErrorCode.Network, err instanceof Error ? err.message : String(err))
    }
    const ms = Date.now() - startedAt
    // Log path + status + timing only — never the auth header. The retry suffix
    // makes a slow-then-succeed sequence obvious in the panel.
    const suffix = attempt > 0 ? ` (attempt ${attempt + 1})` : ''
    this._opts.logger?.info('api', `${method} ${redacted} → ${res.status} in ${ms}ms${suffix}`)
    if (!res.ok) {
      const detail = await safeText(res)
      if (detail) this._opts.logger?.debug('api', `  ↳ error body: ${detail}`)
      throw mapHttpError(res.status, detail)
    }
    return (await safeJson<T>(res)) as T
  }
}

/** A compact, credential-free description of a request body for trace lines. */
function describeBody(body: unknown): string {
  if (body === undefined) return ''
  try {
    const json = JSON.stringify(body)
    return json.length > 200 ? ` body=${json.slice(0, 200)}…` : ` body=${json}`
  } catch {
    return ''
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** DOMException (the fetch abort/timeout reason) is not reliably `instanceof
 *  Error`, so read the name structurally. */
function errorName(err: unknown): string {
  if (typeof err !== 'object' || err === null) return ''
  const name = (err as { name?: unknown }).name
  return typeof name === 'string' ? name : ''
}

/** Strip the origin so logs carry only the API path, not a host that could hint
 *  at internal infrastructure. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    return u.pathname + u.search
  } catch {
    return url
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500)
  } catch {
    return ''
  }
}

async function safeJson<T>(res: Response): Promise<T | undefined> {
  try {
    const text = await res.text()
    if (!text.trim()) return undefined
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}
