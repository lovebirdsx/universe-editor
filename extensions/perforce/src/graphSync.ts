/**
 * Pure decision helpers for the graph's "Get Revision" flows, kept out of
 * `extension.ts` so they stay unit-testable. The sync itself always runs
 * through `runSync` — these only shape its inputs.
 */

import { scopeCovers } from './graphSyncLedger.js'
import type { SyncScopeTarget } from './p4Filespec.js'
import { scopeKey } from './pathUtil.js'

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

/** Which dialog a graph get must show before it runs. */
export type GraphSyncConfirm = 'none' | 'timeTravel' | 'force'

/**
 * Force outranks every other reason to confirm. A forced get destroys
 * uncollected local work whether or not it also moves files in time, and its
 * own dialog spells out both — so the three time-travel waivers (a single file,
 * the latest row, the multi-directory dialog's confirm) cannot waive it.
 *
 * `force` is deliberately NOT part of {@link GraphSyncConfirmInput}: passing it
 * to `graphSyncNeedsConfirm` is a type error, so nobody can read "no time-travel
 * warning" as "no warning at all".
 */
export function graphSyncConfirmKind(
  input: GraphSyncConfirmInput & { readonly force?: boolean },
): GraphSyncConfirm {
  if (input.force === true) return 'force'
  return graphSyncNeedsConfirm(input) ? 'timeTravel' : 'none'
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

export type DirectSyncPoint =
  | { readonly ok: true; readonly change: string }
  /** `reason` is a short phrase for the log line and for tests; every one of
   *  these means the same thing operationally — ask p4 instead of guessing. */
  | { readonly ok: false; readonly reason: string }

export interface DirectSyncPointInput {
  /** Bare changelist number (already through {@link clSpecOf}). */
  readonly change: string
  /** What this get covers, in ledger coordinates. */
  readonly getScope: readonly SyncScopeTarget[]
  /** The client this get resolves to. */
  readonly getClientRoot: string
  /** The listing scope the row came from, resolved the same way the listing was. */
  readonly listed?: {
    readonly scope: readonly SyncScopeTarget[]
    readonly clientRoot: string
    /** The listing was the whole-repo one (`//...`, the graph's globe toggle). */
    readonly wholeRepo?: boolean
  }
  /** The client the renderer loaded those rows from (its `clientRoot` echo). */
  readonly displayedClientRoot?: string
}

/**
 * The changelist a get must record when it can prove where it landed WITHOUT
 * asking p4 — or the reason it cannot and has to read the answer back.
 *
 * A graph row exists because its changelist touched something inside the scope
 * the listing was filtered by, so a get whose scope COVERS that listing scope
 * necessarily landed on that very changelist: the read-back asks for the newest
 * change at or below it touching the scope, and the row's own changelist is one
 * of them and nothing newer can be. The two are equivalent, not approximate.
 *
 * Everything else is a refusal, and refusing only costs a read-back — the write
 * this feeds is a claim about the user's workspace, so the one direction that
 * must stay impossible is recording a changelist the scope never synced (which
 * would badge a row that was never pulled). That is why the listing scope is
 * stated by the caller rather than derived from this get's own scope: in the
 * multi-directory dialog those differ, and deriving it would make the coverage
 * test trivially true.
 *
 * The proof needs both sides named in the SAME coordinates. A whole-repo
 * listing (`//...`) is not, so it is refused rather than excused — see the note
 * on that branch for why its coverage test would be vacuous.
 */
export function directSyncPoint(input: DirectSyncPointInput): DirectSyncPoint {
  const listed = input.listed
  if (listed === undefined) return { ok: false, reason: 'no listing scope' }
  // A whole-repo listing is refused outright, and NOT because it is wide: the
  // extension writes every ledger coordinate as a HOST path under the client
  // root, while the row came from `p4 changes //...` — a depot-level query. The
  // coverage test would be trivially true (both sides are the client root), so
  // the proof above would rest on an assumption never established: that every
  // change `//...` lists touched a file this client's view maps under its root.
  // The have probe only ever argued the OTHER direction (its answer is a subset
  // of the listing), which is not enough here. When the assumption fails, the
  // direct answer disagrees with what the read-back would have said for the very
  // same get — and a later query button press, which IS the truth channel, then
  // visibly moves the badge backwards. Refusing costs the whole-repo tab the
  // read-back it has always paid; it buys one answer per get.
  if (listed.wholeRepo === true) return { ok: false, reason: 'whole-repo listing' }
  // An empty scope is not a narrower scope, it is a MISSING one: `scopeCovers`
  // says it is covered by everything, and the graph resolves an empty
  // `scopePaths` as "no scope given" (the opened folder). Both readings would
  // turn "declared nothing" into "declared the widest thing there is".
  if (listed.scope.length === 0) return { ok: false, reason: 'empty listing scope' }
  const get = scopeKey(input.getClientRoot)
  if (scopeKey(listed.clientRoot) !== get) {
    return { ok: false, reason: 'listing from another client' }
  }
  // The rows on screen came from a listing the renderer loaded; if that listing
  // was of a different client, the row ids in hand belong to that one. Both
  // sides resolve against the CURRENT graph client, so without this echo a
  // client switch would compare a stale row against the new client's scope and
  // agree with itself.
  if (input.displayedClientRoot === undefined) {
    return { ok: false, reason: 'no listing client echoed' }
  }
  if (scopeKey(input.displayedClientRoot) !== get) {
    return { ok: false, reason: 'rows not from this client' }
  }
  if (!scopeCovers(input.getScope, listed.scope)) {
    return { ok: false, reason: 'get scope does not cover the listing scope' }
  }
  return { ok: true, change: input.change }
}
