/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Value normalization + validation helpers shared by ConfigResolver.
 *--------------------------------------------------------------------------------------------*/

import type { RawConfigValue } from './configSource.js'

export function asString(raw: RawConfigValue): string | undefined {
  if (typeof raw === 'string') return raw === '' ? undefined : raw
  return undefined
}

/** Recognizes '1' and 'true' as true; everything else (incl. '0', '') as false. */
export function asBoolean(raw: RawConfigValue): boolean | undefined {
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'string') {
    if (raw === '1' || raw === 'true') return true
    if (raw === '0' || raw === 'false' || raw === '') return false
    return false
  }
  return undefined
}

export function asStringArray(raw: RawConfigValue): string[] | undefined {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') return raw === '' ? undefined : [raw]
  return undefined
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
