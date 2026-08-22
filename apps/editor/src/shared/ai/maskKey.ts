/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared API-key masking for the AI settings UI. Rule: first 4 + last 4
 *  characters with a fixed dot run in between; short keys hide entirely. Kept
 *  identical to the provider-instance card so every surface masks the same way.
 *--------------------------------------------------------------------------------------------*/

/** Mask a key: first 4 + last 4 with fixed dots; short keys hide entirely. */
export function maskKey(key: string): string {
  if (key.length <= 8) return '•'.repeat(8)
  return `${key.slice(0, 4)}••••••••••${key.slice(-4)}`
}
