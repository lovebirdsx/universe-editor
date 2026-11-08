/** Phone-local preference storage; disabled or throwing storage keeps the defaults. */

export function readStoredString(key: string): string | undefined {
  try {
    return globalThis.localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

export function writeStoredString(key: string, value: string): void {
  try {
    globalThis.localStorage.setItem(key, value)
  } catch {
    // Storage is optional: the preference still applies for this page.
  }
}
