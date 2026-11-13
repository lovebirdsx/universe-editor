/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Failure backoff and auto-pause thresholds for trigger runs.
 *--------------------------------------------------------------------------------------------*/

import { TRIGGER_DEFAULTS } from './types.js'

export const BACKOFF_BASE_MS = 60_000
export const BACKOFF_MAX_MS = 60 * 60_000

/** 1m, 2m, 4m, ... capped at 1h. No failures means no delay. */
export function nextBackoffMs(consecutiveFailures: number): number {
  if (!Number.isFinite(consecutiveFailures) || consecutiveFailures <= 0) return 0
  const exponent = Math.floor(consecutiveFailures) - 1
  return Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_MAX_MS)
}

export function shouldAutoPause(
  consecutiveFailures: number,
  threshold: number = TRIGGER_DEFAULTS.failurePauseThreshold,
): boolean {
  if (threshold <= 0) return false
  return consecutiveFailures >= threshold
}
