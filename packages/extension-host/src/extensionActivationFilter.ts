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
   * (even empty) → activate ONLY these BUILT-IN ids. Composes with `disabled`: a
   * listed-but-disabled id still stays off.
   *
   * The allowlist gates BUILT-IN extensions WITH AN ENTRY MODULE only. The seam
   * exists to not boot the app's own bundled LSP/SCM hosts; declaration-only
   * extensions (`mainPath` undefined — pure `contributes` like theme-defaults)
   * cost no host process, so they always activate. User-installed extensions
   * (`builtin: false`, e.g. a vsix installed at runtime by an e2e spec) are an
   * explicit user action and always activate too — the minimal-set seam is
   * about not booting hosts, not about blocking contributions or installs.
   */
  readonly allowlist?: ReadonlySet<string>
}

/**
 * De-dupe scanned extensions by id (first occurrence wins — the caller orders
 * the scan dev > built-in > user, so a --extension-development-path extension
 * overrides a same-id built-in or installed copy), then drop disabled and, when
 * an allowlist is present, drop BUILT-INS WITH A MAIN MODULE not on it
 * (declaration-only built-ins and user-installed extensions are never gated).
 *
 * Development extensions (`isUnderDevelopment`) are exempt from the disabled
 * set: VSCode's dev extensions don't participate in the enablement system at
 * all, and the dev semantic is "override everything" — a user who disabled the
 * shipped build of the extension they're iterating on must still see their
 * dev copy activate.
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
  const gatedByAllowlist = (e: IScannedExtension): boolean =>
    allowlist !== undefined && e.builtin && e.mainPath !== undefined && !allowlist.has(e.id)
  const active = deduped.filter(
    (e) => !((disabled?.has(e.id) ?? false) && !e.isUnderDevelopment) && !gatedByAllowlist(e),
  )
  return { deduped, active }
}

/** Parse a comma-separated env var into a Set, or undefined when unset. */
export function parseIdSet(raw: string | undefined): Set<string> | undefined {
  if (raw === undefined) return undefined
  return new Set(raw.split(',').filter(Boolean))
}
