/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The single activation confirmation (which also covers a bypass-class mode)
 *  binds to this fingerprint. It is main-only: a 32-bit FNV hash would be cheap
 *  to collide on purpose, so trusted folder content could otherwise reproduce a
 *  confirmed definition after a pull.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto'
import type { TriggerConfig } from '../../../shared/triggers/types.js'

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key])
    return sorted
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Stable SHA-256 of the canonical (key-order independent) trigger JSON.
 *
 * Config snapshots are immutable per load (a reload builds new objects), so the
 * digest is memoized by object identity: summaries and change notifications read
 * the fingerprint on every pass and must not re-hash the whole config each time.
 */
export function triggerFingerprint(trigger: TriggerConfig): string {
  const cached = CACHE.get(trigger)
  if (cached !== undefined) return cached
  const digest = createHash('sha256')
    .update(JSON.stringify(canonicalize(trigger)))
    .digest('hex')
  CACHE.set(trigger, digest)
  return digest
}

const CACHE = new WeakMap<TriggerConfig, string>()
