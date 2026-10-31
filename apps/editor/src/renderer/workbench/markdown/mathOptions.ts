/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Normalizes the `markdown.math.macros` setting into the shape KaTeX accepts.
 *--------------------------------------------------------------------------------------------*/

export const EMPTY_MATH_MACROS: Readonly<Record<string, string>> = Object.freeze({})

/**
 * Keep only non-empty string keys with string values. The setting is user JSON,
 * so a hand-edited settings file can hold arrays, nulls or numbers; KaTeX would
 * either ignore or choke on those, and a stable "no macros" identity keeps the
 * renderer memo from recomputing on every configuration read.
 */
export function sanitizeMathMacros(raw: unknown): Readonly<Record<string, string>> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_MATH_MACROS
  let out: Record<string, string> | undefined
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.length === 0 || typeof value !== 'string') continue
    out ??= {}
    out[key] = value
  }
  return out ?? EMPTY_MATH_MACROS
}
