/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared provider helpers: exponential-backoff retry. Each vendor decides which
 *  errors are retryable (rate limits, transient network) and wraps its request
 *  with retryWithBackoff. The facade does not retry — only the provider knows the
 *  vendor's semantics.
 *--------------------------------------------------------------------------------------------*/

import {
  type CancellationToken,
  AiError,
  AiErrorCode,
  CancellationError,
  DisposableStore,
} from '@universe-editor/platform'

export interface RetryOptions {
  readonly maxAttempts?: number
  readonly baseDelayMs?: number
  readonly maxDelayMs?: number
  /** Return true to retry the given error; default never retries. */
  readonly isRetryable?: (err: unknown) => boolean
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  token: CancellationToken,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3
  const baseDelayMs = options.baseDelayMs ?? 300
  const maxDelayMs = options.maxDelayMs ?? 5_000
  const isRetryable = options.isRetryable ?? (() => false)

  let attempt = 0
  for (;;) {
    if (token.isCancellationRequested) throw new CancellationError()
    try {
      return await fn()
    } catch (err) {
      attempt++
      if (attempt >= maxAttempts || !isRetryable(err) || token.isCancellationRequested) {
        throw err
      }
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
      await delayWithCancellation(delay, token)
    }
  }
}

function delayWithCancellation(ms: number, token: CancellationToken): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const handle = setTimeout(() => {
      sub.dispose()
      resolve()
    }, ms)
    const sub = token.onCancellationRequested(() => {
      clearTimeout(handle)
      sub.dispose()
      reject(new CancellationError())
    })
  })
}

/**
 * Bridge a {@link CancellationToken} to an {@link AbortSignal} for `fetch`. The
 * cancellation listener is parked in `store`, but ALSO disposes `store`
 * synchronously when it fires — so a `cts.cancel()` at shutdown tears the abort
 * pipeline down in the same tick, before the process-exit leak check runs (the
 * request's own `finally` only disposes `store` a microtask later, too late).
 * Disposing the store is idempotent, so the `finally` path stays correct too.
 */
export function toAbortSignal(token: CancellationToken, store: DisposableStore): AbortSignal {
  const controller = new AbortController()
  if (token.isCancellationRequested) {
    controller.abort()
  } else {
    store.add(
      token.onCancellationRequested(() => {
        controller.abort()
        store.dispose()
      }),
    )
  }
  return controller.signal
}

/**
 * Why the model listing failed, as a typed error instead of an empty array — the
 * two helpers below keep the four providers' `listModels` telling "could not
 * reach the endpoint" apart from "the endpoint refused us". Collapsing both into
 * `[]` is what made every failure read as "no models available".
 */
export function modelsNetworkError(err: unknown, token: CancellationToken): Error {
  if (token.isCancellationRequested || (err instanceof Error && err.name === 'AbortError')) {
    return new CancellationError()
  }
  return new AiError(AiErrorCode.NetworkError, err instanceof Error ? err.message : String(err))
}

export function modelsEndpointError(status: number): AiError {
  const code = status === 401 || status === 403 ? AiErrorCode.Unauthorized : AiErrorCode.Unknown
  return new AiError(code, `HTTP ${status}`, status)
}
