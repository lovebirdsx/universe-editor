/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  One-time pairing codes. The code lives in memory only as a SHA-256 digest,
 *  expires after 120s, is consumed on the first successful redeem, and is
 *  replaced whenever a new code is generated. Failed attempts are rate limited
 *  per remote address; too many consecutive failures invalidate the code.
 *--------------------------------------------------------------------------------------------*/

import { createHash, timingSafeEqual } from 'node:crypto'
import {
  generatePairCode,
  isValidPairCodeShape,
  normalizePairCode,
} from '@universe-editor/mobile-protocol'

export const PAIR_CODE_TTL_MS = 120_000
const MAX_ATTEMPTS_PER_IP_PER_MINUTE = 5
const ATTEMPT_WINDOW_MS = 60_000
const MAX_CONSECUTIVE_FAILURES = 10
const FIXED_CODE_EXPIRES_AT = Number.MAX_SAFE_INTEGER

export type PairRedeemResult = 'ok' | 'invalid' | 'expired' | 'rate_limited'

export interface PairingCodeSession {
  readonly code: string
  readonly expiresAt: number
}

interface CurrentCode {
  readonly hash: Buffer
  readonly expiresAt: number
  readonly fixed: boolean
}

export interface PairingServiceOptions {
  readonly now?: () => number
  readonly ttlMs?: number
  /** E2E only: a fixed code that never expires and is not consumed on success. */
  readonly fixedCode?: string
  readonly maxAttemptsPerIpPerMinute?: number
  readonly maxConsecutiveFailures?: number
}

export class PairingService {
  private readonly _now: () => number
  private readonly _ttlMs: number
  private readonly _fixedCode: string | undefined
  private readonly _maxAttemptsPerIp: number
  private readonly _maxConsecutiveFailures: number
  private readonly _attempts = new Map<string, number[]>()
  private _current: CurrentCode | undefined
  private _consecutiveFailures = 0

  constructor(options: PairingServiceOptions = {}) {
    this._now = options.now ?? Date.now
    this._ttlMs = options.ttlMs ?? PAIR_CODE_TTL_MS
    this._fixedCode = options.fixedCode
    this._maxAttemptsPerIp = options.maxAttemptsPerIpPerMinute ?? MAX_ATTEMPTS_PER_IP_PER_MINUTE
    this._maxConsecutiveFailures = options.maxConsecutiveFailures ?? MAX_CONSECUTIVE_FAILURES
  }

  /** Mint a new code, invalidating any previous one. */
  start(): PairingCodeSession {
    this._consecutiveFailures = 0
    if (this._fixedCode !== undefined) {
      this._current = {
        hash: hashCode(this._fixedCode),
        expiresAt: FIXED_CODE_EXPIRES_AT,
        fixed: true,
      }
      return { code: this._fixedCode, expiresAt: FIXED_CODE_EXPIRES_AT }
    }
    const code = generatePairCode()
    const expiresAt = this._now() + this._ttlMs
    this._current = { hash: hashCode(code), expiresAt, fixed: false }
    return { code, expiresAt }
  }

  cancel(): void {
    this._current = undefined
    this._consecutiveFailures = 0
  }

  get active(): boolean {
    if (this._current === undefined) return false
    return this._current.fixed || this._now() <= this._current.expiresAt
  }

  redeem(code: string, remoteAddress: string): PairRedeemResult {
    const now = this._now()
    if (this._isRateLimited(remoteAddress, now)) return 'rate_limited'

    const current = this._current
    if (current === undefined) {
      this._recordFailure(remoteAddress, now)
      return 'invalid'
    }
    if (!current.fixed && now > current.expiresAt) {
      this._current = undefined
      this._recordFailure(remoteAddress, now)
      return 'expired'
    }
    const normalized = normalizePairCode(code)
    if (!isValidPairCodeShape(normalized)) {
      this._recordFailure(remoteAddress, now)
      return 'invalid'
    }
    if (!safeEqual(hashCode(normalized), current.hash)) {
      this._recordFailure(remoteAddress, now)
      return 'invalid'
    }
    if (!current.fixed) this._current = undefined
    this._consecutiveFailures = 0
    return 'ok'
  }

  private _isRateLimited(remoteAddress: string, now: number): boolean {
    this._pruneAttempts(now)
    const attempts = this._attempts.get(remoteAddress)
    return attempts !== undefined && attempts.length >= this._maxAttemptsPerIp
  }

  private _recordFailure(remoteAddress: string, now: number): void {
    const attempts = this._attempts.get(remoteAddress) ?? []
    attempts.push(now)
    this._attempts.set(remoteAddress, attempts)
    this._consecutiveFailures += 1
    if (this._consecutiveFailures >= this._maxConsecutiveFailures) {
      this._current = undefined
      this._consecutiveFailures = 0
    }
  }

  private _pruneAttempts(now: number): void {
    for (const [address, times] of this._attempts) {
      const fresh = times.filter((time) => now - time < ATTEMPT_WINDOW_MS)
      if (fresh.length === 0) this._attempts.delete(address)
      else this._attempts.set(address, fresh)
    }
  }
}

function hashCode(code: string): Buffer {
  return createHash('sha256').update(normalizePairCode(code), 'utf8').digest()
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
