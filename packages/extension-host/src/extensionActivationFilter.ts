/**
 * Pure activation-set computation for the extension host bootstrap. Kept separate
 * from bootstrap.ts (which is a process entrypoint that can't be unit-tested) so
 * the dedupe + disabled + allowlist rules are directly covered by tests.
 */
import type { IScannedExtension } from './extensionScanner.js'

export interface ActivationFilter {
  /** Ids explicitly disabled (global ∪ workspace), from UNIVERSE_DISABLED_EXTENSIONS. */
  readonly disabled?: ReadonlySet<string>
  /**
   * Allowlist (e2e minimal-extension-set), from UNIVERSE_ENABLED_EXTENSIONS.
   * `undefined` → no allowlist (activate all scanned, minus `disabled`). A set
   * (even empty) → activate ONLY these ids. Composes with `disabled`: a
   * listed-but-disabled id still stays off.
   */
  readonly allowlist?: ReadonlySet<string>
}

/**
 * De-dupe scanned extensions by id (first occurrence wins — built-in over user,
 * since the caller scans built-in dir first), then drop disabled and, when an
 * allowlist is present, anything not on it.
 */
export function computeActiveExtensions(
  scanned: readonly IScannedExtension[],
  filter: ActivationFilter = {},
): {
  readonly deduped: readonly IScannedExtension[]
  readonly active: readonly IScannedExtension[]
} {
  const seen = new Set<string>()
  const deduped = scanned.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
  const { disabled, allowlist } = filter
  const active = deduped.filter(
    (e) => !(disabled?.has(e.id) ?? false) && (allowlist === undefined || allowlist.has(e.id)),
  )
  return { deduped, active }
}

/** Parse a comma-separated env var into a Set, or undefined when unset. */
export function parseIdSet(raw: string | undefined): Set<string> | undefined {
  if (raw === undefined) return undefined
  return new Set(raw.split(',').filter(Boolean))
}
