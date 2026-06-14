/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared provider helpers: exponential-backoff retry. Each vendor decides which
 *  errors are retryable (rate limits, transient network) and wraps its request
 *  with retryWithBackoff. The facade does not retry — only the provider knows the
 *  vendor's semantics.
 *--------------------------------------------------------------------------------------------*/

import { type CancellationToken, CancellationError } from '@universe-editor/platform'

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
