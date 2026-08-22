/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for the pure gateway-JSON parsers: dotted path lookup, rate-table
 *  normalization (array / object shapes, unit scaling, currency, half-rate skip),
 *  account-usage normalization, and option-bag validation.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  parseAccountUsage,
  parseRateTable,
  pickPath,
  readAccountUsageOptions,
  readRateTableOptions,
  toFiniteNumber,
} from '../parseRemoteJson.js'

describe('pickPath', () => {
  it('reads nested dotted paths', () => {
    expect(pickPath({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42)
    expect(pickPath({ a: { b: 1 } }, 'a.b')).toBe(1)
  })

  it('returns the root for an empty path', () => {
    const root = { a: 1 }
    expect(pickPath(root, '')).toBe(root)
  })

  it('returns undefined on any miss', () => {
    expect(pickPath({ a: { b: 1 } }, 'a.b.c')).toBeUndefined()
    expect(pickPath({ a: { b: 1 } }, 'a.x')).toBeUndefined()
    expect(pickPath(null, 'a')).toBeUndefined()
    expect(pickPath('str', 'a')).toBeUndefined()
    expect(pickPath(42, 'a')).toBeUndefined()
    expect(pickPath({ a: [1, 2, 3] }, 'a.0')).toBeUndefined()
  })
})

describe('toFiniteNumber', () => {
  it('accepts numbers and numeric strings', () => {
    expect(toFiniteNumber(3)).toBe(3)
    expect(toFiniteNumber('3.5')).toBe(3.5)
    expect(toFiniteNumber(' 2 ')).toBe(2)
    expect(toFiniteNumber(0)).toBe(0)
  })

  it('rejects non-numbers', () => {
    expect(toFiniteNumber('abc')).toBeUndefined()
    expect(toFiniteNumber('')).toBeUndefined()
    expect(toFiniteNumber('   ')).toBeUndefined()
    expect(toFiniteNumber(Number.NaN)).toBeUndefined()
    expect(toFiniteNumber(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(toFiniteNumber(null)).toBeUndefined()
    expect(toFiniteNumber(undefined)).toBeUndefined()
    expect(toFiniteNumber({})).toBeUndefined()
  })
})

describe('parseRateTable', () => {
  it('parses the one-api style array shape', () => {
    const rates = parseRateTable(
      { data: [{ id: 'gpt-4o', input: 2.5, output: 10 }] },
      { itemsPath: 'data' },
    )
    expect(rates['gpt-4o']).toEqual({ input: 2.5, output: 10 })
  })

  it('accepts numeric strings for input/output', () => {
    const rates = parseRateTable(
      { data: [{ id: 'm', input: '0.15', output: '0.6' }] },
      { itemsPath: 'data' },
    )
    expect(rates['m']).toEqual({ input: 0.15, output: 0.6 })
  })

  it('parses an object keyed by model id', () => {
    const rates = parseRateTable(
      {
        'gpt-4o': { input: 2.5, output: 10 },
        'gpt-4o-mini': { input: 0.15, output: 0.6 },
      },
      {},
    )
    expect(Object.keys(rates).sort()).toEqual(['gpt-4o', 'gpt-4o-mini'])
  })

  it('scales a per-1K unit up to per-1M', () => {
    const rates = parseRateTable(
      { data: [{ id: 'm', input: 1, output: 2 }] },
      { itemsPath: 'data', unit: 1000 },
    )
    expect(rates['m']).toEqual({ input: 1000, output: 2000 })
  })

  it('marks CNY rates and leaves USD as the default (omitted)', () => {
    const cny = parseRateTable(
      { data: [{ id: 'm', input: 1, output: 2 }] },
      { itemsPath: 'data', currency: 'CNY' },
    )
    expect(cny['m']).toEqual({ currency: 'CNY', input: 1, output: 2 })

    const usd = parseRateTable({ data: [{ id: 'm', input: 1, output: 2 }] }, { itemsPath: 'data' })
    expect(usd['m']).toEqual({ input: 1, output: 2 })
  })

  it('carries cacheRead/cacheWrite through when present', () => {
    const rates = parseRateTable(
      { data: [{ id: 'm', input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 }] },
      { itemsPath: 'data' },
    )
    expect(rates['m']).toEqual({ input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 })
  })

  it('skips items missing a usable input or output rate', () => {
    const rates = parseRateTable(
      {
        data: [
          { id: 'ok', input: 1, output: 2 },
          { id: 'half', input: 1 },
          { id: 'half2', output: 2 },
          { id: 'junk', input: 'x', output: 2 },
        ],
      },
      { itemsPath: 'data' },
    )
    expect(Object.keys(rates)).toEqual(['ok'])
  })

  it('ignores malformed entries without failing the batch', () => {
    const rates = parseRateTable(
      {
        data: [
          { id: 'ok', input: 1, output: 2 },
          null,
          'junk',
          42,
          { id: 42, input: 1, output: 2 },
          { input: 3, output: 4 },
          { id: 'ok2', input: 3, output: 4 },
        ],
      },
      { itemsPath: 'data' },
    )
    expect(Object.keys(rates).sort()).toEqual(['ok', 'ok2'])
  })

  it('reads the model id from a custom field and maps custom rate fields', () => {
    const rates = parseRateTable(
      { data: [{ model: 'm', prompt: 1, completion: 2 }] },
      { itemsPath: 'data', modelField: 'model', fields: { input: 'prompt', output: 'completion' } },
    )
    expect(rates['m']).toEqual({ input: 1, output: 2 })
  })
})

describe('parseAccountUsage', () => {
  it('reads used / limit / remaining', () => {
    const usage = parseAccountUsage({ used: 100, limit: 1000, remaining: 900 }, {}, 12345)
    expect(usage).toEqual({
      kind: 'quota',
      usedUSD: 100,
      limitUSD: 1000,
      remainingUSD: 900,
      fetchedAt: 12345,
    })
  })

  it('divides by the credit unit (one-api quota)', () => {
    const usage = parseAccountUsage(
      { data: { quota: 500000, used_quota: 250000, remaining_quota: 100000 } },
      {
        itemsPath: 'data',
        fields: { limit: 'quota', used: 'used_quota', remaining: 'remaining_quota' },
        unit: 500000,
      },
      12345,
    )
    expect(usage?.limitUSD).toBeCloseTo(1)
    expect(usage?.usedUSD).toBeCloseTo(0.5)
    expect(usage?.remainingUSD).toBeCloseTo(0.2)
  })

  it('returns undefined when none of used / limit / remaining is present', () => {
    expect(parseAccountUsage({ foo: 1 }, {}, 12345)).toBeUndefined()
    expect(parseAccountUsage({ used: undefined, limit: undefined }, {}, 12345)).toBeUndefined()
    expect(parseAccountUsage([], {}, 12345)).toBeUndefined()
    expect(parseAccountUsage('x', {}, 12345)).toBeUndefined()
  })

  it('honours kind and currency', () => {
    expect(parseAccountUsage({ used: 1 }, { kind: 'balance' }, 1)?.kind).toBe('balance')
    expect(parseAccountUsage({ used: 1 }, { currency: 'CNY' }, 1)?.currency).toBe('CNY')
    expect(
      parseAccountUsage({ used: 1, currency: 'cny' }, { fields: { currency: 'currency' } }, 1)
        ?.currency,
    ).toBe('CNY')
  })
})

describe('option readers', () => {
  it('reads valid rate options and ignores junk', () => {
    expect(
      readRateTableOptions({
        itemsPath: 'data',
        modelField: 'model',
        unit: 1000,
        currency: 'CNY',
        fields: { input: 'prompt', output: 'completion', junk: 123 },
      }),
    ).toEqual({
      itemsPath: 'data',
      modelField: 'model',
      unit: 1000,
      currency: 'CNY',
      fields: { input: 'prompt', output: 'completion' },
    })
  })

  it('falls back to defaults on invalid rate options', () => {
    expect(
      readRateTableOptions({
        itemsPath: 123,
        modelField: '',
        unit: -1,
        currency: 'EUR',
        fields: 'not-object',
      }),
    ).toEqual({})
    expect(readRateTableOptions(undefined)).toEqual({})
  })

  it('reads valid usage options and ignores junk', () => {
    expect(
      readAccountUsageOptions({
        itemsPath: 'data',
        unit: 500000,
        kind: 'balance',
        currency: 'USD',
        fields: { used: 'used_quota', limit: 'quota' },
      }),
    ).toEqual({
      itemsPath: 'data',
      unit: 500000,
      kind: 'balance',
      currency: 'USD',
      fields: { used: 'used_quota', limit: 'quota' },
    })
  })

  it('falls back to defaults on invalid usage options', () => {
    expect(readAccountUsageOptions({ kind: 'bogus', unit: 0, fields: { used: 1 } })).toEqual({})
  })
})
