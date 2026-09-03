/**
 * Pure decision helpers for the graph's "Get Revision" flows, kept out of
 * `extension.ts` so they stay unit-testable. The sync itself always runs
 * through `runSync` — these only shape its inputs.
 */

/**
 * The p4 revision suffix for a changelist row id: `'4521'` (or `'@4521'` when
 * a caller already carries the sigil) → `'@4521'`. Anything that is not a bare
 * changelist number is rejected — an unchecked id would splice arbitrary text
 * into a filespec.
 */
export function clSpecOf(change: string): string | undefined {
  const m = /^@?(\d+)$/.exec(change.trim())
  return m ? `@${m[1]}` : undefined
}

export interface GraphSyncConfirmInput {
  /** Explicit sync scope; absent/empty = the graph's displayed range. */
  readonly scopePaths?: readonly { readonly path: string; readonly isDirectory: boolean }[]
  /** Target row is the newest loaded change — a get-latest equivalent. */
  readonly isLatest?: boolean
  /** The request comes from the multi-directory dialog, which the user has
   *  already confirmed with its explicit button. */
  readonly confirmed?: boolean
}

/**
 * Whether a graph get-revision needs the time-travel warning before running.
 *
 *  A single file rolling revisions is P4V's most casual sync — never confirmed.
 *  Anything broader (a directory, several directories, or the whole displayed
 *  range) moves files the user has not picked one by one, so it asks first —
 *  unless the target row is the latest (= get latest) or the multi-directory
 *  dialog's confirm button already stood in for it.
 */
export function graphSyncNeedsConfirm(input: GraphSyncConfirmInput): boolean {
  if (input.confirmed === true || input.isLatest === true) return false
  const scopes = input.scopePaths
  if (scopes === undefined || scopes.length === 0) return true
  if (scopes.length > 1) return true
  const first = scopes[0]
  return first === undefined ? true : first.isDirectory
}

/**
 * Resolve every path to one owning client (longest-prefix data-query semantics,
 * no active-client fallback). Returns the common owner, or undefined when the
 * list is empty, any path resolves to nothing, or two paths resolve to
 * different clients — a get must never span workspaces, since p4 runs it
 * against a single client.
 */
export function resolveCommonClient<T>(
  paths: readonly string[],
  resolve: (path: string) => T | undefined,
): T | undefined {
  if (paths.length === 0) return undefined
  const owner = resolve(paths[0]!)
  if (owner === undefined) return undefined
  for (let i = 1; i < paths.length; i++) {
    if (resolve(paths[i]!) !== owner) return undefined
  }
  return owner
}
