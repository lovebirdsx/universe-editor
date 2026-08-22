/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for AiRemoteCache: dual TTL (via the injected `now` argument, not a fake
 *  clock), missing/corrupt/wrong-version files treated as empty, prune dropping
 *  dead providers, atomic flush round-tripping to a fresh instance, and the
 *  allRates snapshot shape.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AiRemoteCache, RATES_TTL_MS, USAGE_TTL_MS } from '../remote/remoteCache.js'

const RATES = { m: { input: 1, output: 2 } }

function makeCache(dir: string): AiRemoteCache {
  return new AiRemoteCache(async () => dir)
}

describe('AiRemoteCache', () => {
  it('treats a missing file as empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-remote-cache-'))
    const cache = makeCache(dir)
    await cache.load()
    expect(cache.allRates()).toEqual([])
    expect(cache.getRates('a/b')).toBeUndefined()
    expect(cache.getUsage('a/b')).toBeUndefined()
  })

  it('treats a corrupt file as empty without throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-remote-cache-'))
    writeFileSync(join(dir, 'aiRemoteCache.json'), '{ not json', 'utf8')
    const cache = makeCache(dir)
    await expect(cache.load()).resolves.toBeUndefined()
    expect(cache.allRates()).toEqual([])
  })

  it('treats a wrong-version file as empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-remote-cache-'))
    writeFileSync(
      join(dir, 'aiRemoteCache.json'),
      JSON.stringify({ version: 99, rates: { 'a/b': { fetchedAt: 1, rates: RATES } } }),
      'utf8',
    )
    const cache = makeCache(dir)
    await cache.load()
    expect(cache.getRates('a/b')).toBeUndefined()
  })

  it('applies the dual TTL using the injected now', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-remote-cache-'))
    const cache = makeCache(dir)
    const now = Date.now()
    cache.setRates('a/b', RATES, now)
    cache.setUsage('a/b', { kind: 'quota', fetchedAt: now })

    expect(cache.isRatesStale('a/b', now)).toBe(false)
    expect(cache.isRatesStale('a/b', now + RATES_TTL_MS - 1)).toBe(false)
    expect(cache.isRatesStale('a/b', now + RATES_TTL_MS)).toBe(true)

    expect(cache.isUsageStale('a/b', now)).toBe(false)
    expect(cache.isUsageStale('a/b', now + USAGE_TTL_MS - 1)).toBe(false)
    expect(cache.isUsageStale('a/b', now + USAGE_TTL_MS)).toBe(true)

    // No cache reads as stale.
    expect(cache.isRatesStale('missing/x', now)).toBe(true)
    expect(cache.isUsageStale('missing/x', now)).toBe(true)
  })

  it('prune drops entries whose provider disappeared', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-remote-cache-'))
    const cache = makeCache(dir)
    await cache.load()
    cache.setRates('keep/x', RATES, 1)
    cache.setRates('drop/y', RATES, 1)
    cache.setUsage('drop/y', { kind: 'quota', fetchedAt: 1 })

    cache.prune(['keep/x'])

    expect(cache.getRates('keep/x')).toBeDefined()
    expect(cache.getRates('drop/y')).toBeUndefined()
    expect(cache.getUsage('drop/y')).toBeUndefined()
  })

  it('flush round-trips through a fresh instance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-remote-cache-'))
    const cache = makeCache(dir)
    await cache.load()
    cache.setRates('a/b', RATES, 1000)
    cache.setUsage('a/b', { kind: 'balance', usedUSD: 1, fetchedAt: 2000 })
    await cache.flush()

    const reloaded = makeCache(dir)
    await reloaded.load()
    expect(reloaded.getRates('a/b')).toEqual({ fetchedAt: 1000, rates: RATES })
    expect(reloaded.getUsage('a/b')).toEqual({ kind: 'balance', usedUSD: 1, fetchedAt: 2000 })
  })

  it('allRates exposes the snapshot shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-remote-cache-'))
    const cache = makeCache(dir)
    cache.setRates('a/b', RATES, 123)
    expect(cache.allRates()).toEqual([{ providerKey: 'a/b', rates: RATES, fetchedAt: 123 }])
  })
})
