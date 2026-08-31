/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared HTTP plumbing for the http-json remote sources: URL assembly, auth
 *  header construction, and a bounded fetch that never throws. Both the pricing
 *  and the usage source build on these so a gateway failure stays a silent no-op.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '@universe-editor/platform'
import type { AiSourceFetchContext, CancellationToken } from '@universe-editor/platform'
import { toAbortSignal } from '../providers/retry.js'

export interface HttpJsonOptions {
  /** Path appended to the baseUrl. */
  readonly path?: string
  /** Attach the apiKey as auth when true (default). Set false for keyless endpoints. */
  readonly auth?: boolean
  /** Custom auth header name (e.g. 'x-api-key'); the value is the raw key, no Bearer. */
  readonly authHeader?: string
  readonly headers?: Readonly<Record<string, string>>
}

export function readHttpJsonOptions(
  options: Readonly<Record<string, unknown>> | undefined,
): HttpJsonOptions {
  if (options === undefined) return {}
  const path = readString(options, 'path')
  const auth = typeof options.auth === 'boolean' ? options.auth : undefined
  const authHeader = readString(options, 'authHeader')
  const headers = readStringRecord(options.headers)
  return {
    ...(path !== undefined ? { path } : {}),
    ...(auth !== undefined ? { auth } : {}),
    ...(authHeader !== undefined ? { authHeader } : {}),
    ...(headers !== undefined ? { headers } : {}),
  }
}

/** Resolve the request URL from the provider context; undefined when there is no baseUrl. */
export function resolveUrl(
  ctx: AiSourceFetchContext,
  options: HttpJsonOptions,
  defaultPath: string,
): string | undefined {
  if (ctx.baseUrl === undefined || ctx.baseUrl === '') return undefined
  return joinUrl(ctx.baseUrl, options.path ?? defaultPath)
}

/** Join a base and path, normalizing the base's trailing slash and the path's leading slash. */
function joinUrl(base: string, path: string): string {
  if (path === '') return base
  if (path.startsWith('http://') || path.startsWith('https://')) return path
  const b = base.endsWith('/') ? base.slice(0, -1) : base
  const p = path.startsWith('/') ? path : `/${path}`
  return `${b}${p}`
}

export function buildHeaders(
  ctx: AiSourceFetchContext,
  options: HttpJsonOptions,
): Record<string, string> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  if (options.auth !== false && ctx.apiKey !== undefined) {
    if (options.authHeader !== undefined) {
      // A custom header (e.g. x-api-key) carries the raw key, not a Bearer token.
      headers[options.authHeader] = ctx.apiKey
    } else {
      headers.Authorization = `Bearer ${ctx.apiKey}`
    }
  }
  return headers
}

/**
 * Bounded fetch: cancels on the token, times out after `timeoutMs`, and returns
 * undefined on any non-2xx / JSON-parse / network failure — it never throws.
 */
export async function fetchJson(
  url: string,
  init: RequestInit,
  token: CancellationToken,
  timeoutMs: number,
): Promise<unknown | undefined> {
  if (token.isCancellationRequested) return undefined
  // The cancellation listener lives in `store`, which `toAbortSignal` tears down
  // synchronously when the token fires — a shutdown-time cancel must not wait for
  // the `finally` below, which only runs a microtask later (after the leak check).
  const store = new DisposableStore()
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.any([toAbortSignal(token, store), timeout.signal]),
    })
    if (!response.ok) return undefined
    return (await response.json()) as unknown
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
    store.dispose()
  }
}

/** Host only — never the query string or any credential baked into the URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    const query = url.indexOf('?')
    return query >= 0 ? url.slice(0, query) : url
  }
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function readStringRecord(raw: unknown): Record<string, string> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}
