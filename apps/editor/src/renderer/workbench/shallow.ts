/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shallow equality for selector results returned from useSnapshot.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shallow equality: compares own enumerable keys of objects with `Object.is`,
 * elements of arrays with `Object.is`, and falls back to `Object.is` otherwise.
 *
 * Use as the third argument to `useSnapshot` when the selector returns an
 * object/array literal so that "same fields, different reference" doesn't
 * trigger a rerender.
 */
export function shallow<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) return false
    }
    return true
  }

  const ka = Object.keys(a as Record<string, unknown>)
  const kb = Object.keys(b as Record<string, unknown>)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (
      !Object.prototype.hasOwnProperty.call(b, k) ||
      !Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    ) {
      return false
    }
  }
  return true
}
