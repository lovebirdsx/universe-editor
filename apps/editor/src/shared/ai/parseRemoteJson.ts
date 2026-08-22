/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure parsers that turn gateway JSON into AiRateTable / AiAccountUsage. Shared by
 *  the http-json pricing and usage sources and tolerant of the messy real-world
 *  shapes one-api / new-api / LiteLLM / OpenRouter return. No network, no filesystem.
 *--------------------------------------------------------------------------------------------*/

import type {
  AiAccountUsage,
  AiCurrency,
  AiModelPricing,
  AiRateTable,
} from '@universe-editor/platform'

/** Read a dotted path out of a parsed JSON value. Returns undefined on any miss. */
export function pickPath(root: unknown, path: string): unknown {
  if (path === '') return root
  let current: unknown = root
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return undefined
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** Coerce to a finite number; strings that look numeric are accepted. Otherwise undefined. */
export function toFiniteNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string') {
    const trimmed = v.trim()
    if (trimmed === '') return undefined
    const n = Number(trimmed)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** Field-mapping for one rate, values are dotted paths relative to an item. */
export interface RateFieldMap {
  readonly input?: string
  readonly output?: string
  readonly cacheRead?: string
  readonly cacheWrite?: string
}

export interface ParseRateTableOptions {
  /** Dotted path to the items container; omitted means the root itself. */
  readonly itemsPath?: string
  /** Field holding the model id when items are an array. Defaults to 'id'. */
  readonly modelField?: string
  readonly fields?: RateFieldMap
  /** Currency the numbers are in. Defaults to 'USD'. */
  readonly currency?: 'USD' | 'CNY'
  /**
   * Tokens the published number is priced per. Rates are normalized to per-1M,
   * so `unit: 1000` means the number is per-1K and gets multiplied by 1000.
   * Defaults to 1_000_000 (already per-1M).
   */
  readonly unit?: number
}

const DEFAULT_RATE_FIELDS: Required<RateFieldMap> = {
  input: 'input',
  output: 'output',
  cacheRead: 'cacheRead',
  cacheWrite: 'cacheWrite',
}

/**
 * Parse a gateway price list into a rate table. Accepts both shapes: an array of
 * items (model id read from `modelField`) and an object keyed by model id. Items
 * missing a usable input/output rate are skipped rather than failing the batch.
 */
export function parseRateTable(root: unknown, options: ParseRateTableOptions): AiRateTable {
  const { itemsPath, modelField = 'id', fields, currency = 'USD', unit = 1_000_000 } = options
  const fieldMap = { ...DEFAULT_RATE_FIELDS, ...fields }
  const factor = unit > 0 ? 1_000_000 / unit : 1
  const items = itemsPath !== undefined ? pickPath(root, itemsPath) : root
  const result: Record<string, AiModelPricing> = {}

  if (Array.isArray(items)) {
    for (const item of items) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
      const id = pickPath(item, modelField)
      if (typeof id !== 'string' || id === '') continue
      const pricing = rateFromItem(item, fieldMap, factor, currency)
      if (pricing !== undefined) result[id] = pricing
    }
  } else if (items !== null && typeof items === 'object' && !Array.isArray(items)) {
    for (const [id, item] of Object.entries(items)) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
      const pricing = rateFromItem(item, fieldMap, factor, currency)
      if (pricing !== undefined) result[id] = pricing
    }
  }
  return result
}

function rateFromItem(
  item: Record<string, unknown>,
  fields: Required<RateFieldMap>,
  factor: number,
  currency: 'USD' | 'CNY',
): AiModelPricing | undefined {
  const input = toFiniteNumber(pickPath(item, fields.input))
  const output = toFiniteNumber(pickPath(item, fields.output))
  // A half rate prices the wrong money — treat the model as unknown instead.
  if (input === undefined || output === undefined) return undefined
  const cacheRead = toFiniteNumber(pickPath(item, fields.cacheRead))
  const cacheWrite = toFiniteNumber(pickPath(item, fields.cacheWrite))
  return {
    ...(currency === 'CNY' ? { currency: 'CNY' as const } : {}),
    input: input * factor,
    output: output * factor,
    ...(cacheRead !== undefined ? { cacheRead: cacheRead * factor } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite: cacheWrite * factor } : {}),
  }
}

export interface UsageFieldMap {
  readonly used?: string
  readonly limit?: string
  readonly remaining?: string
  /** Optional path to a currency string ('USD' / 'CNY', case-insensitive). */
  readonly currency?: string
}

export interface ParseAccountUsageOptions {
  /** Dotted path to the object holding the usage numbers; omitted means the root. */
  readonly itemsPath?: string
  readonly fields?: UsageFieldMap
  readonly currency?: 'USD' | 'CNY'
  /**
   * Divisor turning the gateway's internal credit unit into currency units
   * (one-api's `quota` is 500000 credits per USD, so `unit: 500000`).
   * Defaults to 1.
   */
  readonly unit?: number
  readonly kind?: 'quota' | 'balance' | 'subscription'
}

const DEFAULT_USAGE_FIELDS: Required<Pick<UsageFieldMap, 'used' | 'limit' | 'remaining'>> = {
  used: 'used',
  limit: 'limit',
  remaining: 'remaining',
}

/**
 * Parse a gateway account endpoint into an authoritative usage snapshot.
 * Returns undefined when none of used / limit / remaining is present — the UI
 * shows "unavailable" rather than a fabricated number.
 */
export function parseAccountUsage(
  root: unknown,
  options: ParseAccountUsageOptions,
  fetchedAt: number,
): AiAccountUsage | undefined {
  const { itemsPath, fields, currency, unit = 1, kind = 'quota' } = options
  const fieldMap = { ...DEFAULT_USAGE_FIELDS, ...fields }
  const source = itemsPath !== undefined ? pickPath(root, itemsPath) : root
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return undefined
  const obj = source as Record<string, unknown>
  const used = toFiniteNumber(pickPath(obj, fieldMap.used))
  const limit = toFiniteNumber(pickPath(obj, fieldMap.limit))
  const remaining = toFiniteNumber(pickPath(obj, fieldMap.remaining))
  if (used === undefined && limit === undefined && remaining === undefined) return undefined
  const divisor = unit > 0 ? unit : 1
  const ccy = resolveUsageCurrency(fieldMap.currency, obj, currency)
  return {
    kind,
    ...(used !== undefined ? { usedUSD: used / divisor } : {}),
    ...(limit !== undefined ? { limitUSD: limit / divisor } : {}),
    ...(remaining !== undefined ? { remainingUSD: remaining / divisor } : {}),
    ...(ccy === 'CNY' ? { currency: 'CNY' as const } : {}),
    fetchedAt,
  }
}

function resolveUsageCurrency(
  currencyPath: string | undefined,
  source: Record<string, unknown>,
  fallback: 'USD' | 'CNY' | undefined,
): AiCurrency | undefined {
  if (currencyPath !== undefined) {
    const raw = pickPath(source, currencyPath)
    if (typeof raw === 'string') {
      const upper = raw.trim().toUpperCase()
      if (upper === 'USD' || upper === 'CNY') return upper
    }
  }
  return fallback
}

/** Read the option bag off an AiRemoteSourceSpec into a typed shape, ignoring junk. */
export function readRateTableOptions(
  options: Readonly<Record<string, unknown>> | undefined,
): ParseRateTableOptions {
  if (options === undefined) return {}
  const itemsPath = readString(options, 'itemsPath')
  const modelField = readString(options, 'modelField')
  const fields = readStringFields(options.fields, ['input', 'output', 'cacheRead', 'cacheWrite'])
  const currency = readCurrency(options.currency)
  const unit = toFiniteNumber(options.unit)
  return {
    ...(itemsPath !== undefined ? { itemsPath } : {}),
    ...(modelField !== undefined ? { modelField } : {}),
    ...(fields !== undefined ? { fields } : {}),
    ...(currency !== undefined ? { currency } : {}),
    ...(unit !== undefined && unit > 0 ? { unit } : {}),
  }
}

export function readAccountUsageOptions(
  options: Readonly<Record<string, unknown>> | undefined,
): ParseAccountUsageOptions {
  if (options === undefined) return {}
  const itemsPath = readString(options, 'itemsPath')
  const fields = readStringFields(options.fields, ['used', 'limit', 'remaining', 'currency'])
  const currency = readCurrency(options.currency)
  const unit = toFiniteNumber(options.unit)
  const kind = readUsageKind(options.kind)
  return {
    ...(itemsPath !== undefined ? { itemsPath } : {}),
    ...(fields !== undefined ? { fields } : {}),
    ...(currency !== undefined ? { currency } : {}),
    ...(unit !== undefined && unit > 0 ? { unit } : {}),
    ...(kind !== undefined ? { kind } : {}),
  }
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Validate a nested field map: keep only the keys whose value is a non-empty string. */
function readStringFields<K extends string>(
  raw: unknown,
  keys: readonly K[],
): Partial<Record<K, string>> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const out: Partial<Record<K, string>> = {}
  for (const key of keys) {
    const value = readString(obj, key)
    if (value !== undefined) out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function readCurrency(value: unknown): 'USD' | 'CNY' | undefined {
  return value === 'USD' || value === 'CNY' ? value : undefined
}

function readUsageKind(value: unknown): 'quota' | 'balance' | 'subscription' | undefined {
  return value === 'quota' || value === 'balance' || value === 'subscription' ? value : undefined
}
