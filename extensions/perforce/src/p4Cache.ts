/**
 * A namespace-organized cache for p4 command results, sized to the fact that
 * every p4 call is a server round-trip. Each namespace declares a policy up
 * front, so adding a new cached command is a one-line registration:
 *
 *  - `immutable` — content-addressed data that can never change once produced
 *    (a submitted changelist's `describe`, a specific revision's `print`). Never
 *    expires; safe to persist across sessions via an optional {@link P4CacheDisk}.
 *  - `ttl` — mutable workspace state (`opened`, `changes -s pending`, `where`)
 *    that can go stale. Cached for a short window to absorb bursts (polling,
 *    multi-entry-point reads), then re-fetched. Explicitly invalidated after any
 *    mutation so the SCM view never shows a stale post-mutation snapshot.
 *
 * `invalidateWorkspace()` drops every `ttl` entry (called after a successful
 * mutation); immutable entries are untouched. `invalidateFile(depotOrLocal)`
 * targets entries a single-file operation can stale (reopen / revert).
 *
 * The cache is keyed by (namespace, key); the key must be a stable string the
 * caller derives from the query (e.g. `describe:12345`, `print:<depot>#<rev>`).
 */

/** How long an entry in a namespace stays valid. */
export type P4CachePolicy =
  /** Content-addressed, never expires. `persist` (default true) also mirrors it to
   *  the {@link P4CacheDisk} so it survives sessions; set false for data that is
   *  immutable within a session but not across them (e.g. a depot→local mapping
   *  that depends on the client view). */
  | { readonly kind: 'immutable'; readonly persist?: boolean }
  | { readonly kind: 'ttl'; readonly ttlMs: number }

/** Persistent backend for immutable entries. Sync-shaped reads come from an
 *  in-memory mirror hydrated at construction; writes are fire-and-forget. */
export interface P4CacheDiskBackend {
  /** Value for `<ns>/<key>` if present on disk (already mirrored in memory). */
  get(ns: string, key: string): string | undefined
  /** Persist `<ns>/<key>` = value. Never throws (best-effort). */
  set(ns: string, key: string, value: string): void
}

/** Injectable clock so TTL logic is testable without the real `Date.now()`
 *  (which this repo forbids in workflow scripts / prefers to keep mockable). */
export type P4Clock = () => number

interface Entry {
  readonly value: string
  /** Absolute expiry timestamp (ms); undefined for immutable entries. */
  readonly expiresAt: number | undefined
}

export class P4Cache {
  private readonly _policies = new Map<string, P4CachePolicy>()
  private readonly _store = new Map<string, Map<string, Entry>>()
  private readonly _inFlight = new Map<string, Map<string, Promise<string | undefined>>>()
  private readonly _namespaceGenerations = new Map<string, number>()
  private readonly _keyGenerations = new Map<string, Map<string, number>>()
  private _generation = 0

  constructor(
    private readonly _now: P4Clock = Date.now,
    private readonly _disk?: P4CacheDiskBackend,
    /** Master switch — when false, `wrap` always fetches (no caching at all). */
    private _enabled = true,
  ) {}

  /** Declare a namespace's caching policy. Call once per namespace at setup. */
  register(ns: string, policy: P4CachePolicy): void {
    this._policies.set(ns, policy)
  }

  setEnabled(enabled: boolean): void {
    if (this._enabled === enabled) return
    this._enabled = enabled
    if (!enabled) this.clear()
  }

  /**
   * Return the cached value for `(ns, key)`, else run `fetch`, store the result
   * (respecting the namespace policy) and return it. A `fetch` that resolves to
   * `undefined` is treated as "don't cache" (a failed query), so the next call
   * retries. `ns` must have been {@link register}ed.
   */
  async wrap(
    ns: string,
    key: string,
    fetch: () => Promise<string | undefined>,
  ): Promise<string | undefined> {
    if (!this._enabled) return fetch()
    const policy = this._policies.get(ns)
    if (!policy) throw new Error(`p4Cache: unknown namespace '${ns}'`)

    const hit = this._read(ns, key, policy)
    if (hit !== undefined) return hit

    const existing = this._inFlight.get(ns)?.get(key)
    if (existing) return existing

    const generation = this._generation
    const namespaceGeneration = this._namespaceGenerations.get(ns) ?? 0
    const keyGeneration = this._keyGenerations.get(ns)?.get(key) ?? 0
    const promise = (async () => {
      const value = await fetch()
      if (value === undefined) return undefined
      if (
        this._enabled &&
        generation === this._generation &&
        namespaceGeneration === (this._namespaceGenerations.get(ns) ?? 0) &&
        keyGeneration === (this._keyGenerations.get(ns)?.get(key) ?? 0)
      ) {
        this._write(ns, key, value, policy)
      }
      return value
    })()
    let inFlight = this._inFlight.get(ns)
    if (!inFlight) {
      inFlight = new Map()
      this._inFlight.set(ns, inFlight)
    }
    inFlight.set(key, promise)
    try {
      return await promise
    } finally {
      if (this._inFlight.get(ns)?.get(key) === promise) {
        this._inFlight.get(ns)?.delete(key)
      }
    }
  }

  /** Drop one exact entry without disturbing unrelated data in the namespace. */
  invalidate(ns: string, key: string): void {
    this._store.get(ns)?.delete(key)
    let generations = this._keyGenerations.get(ns)
    if (!generations) {
      generations = new Map()
      this._keyGenerations.set(ns, generations)
    }
    generations.set(key, (generations.get(key) ?? 0) + 1)
    this._inFlight.get(ns)?.delete(key)
  }

  /** Drop every entry in one namespace. */
  invalidateNamespace(ns: string): void {
    this._store.get(ns)?.clear()
    this._namespaceGenerations.set(ns, (this._namespaceGenerations.get(ns) ?? 0) + 1)
    this._keyGenerations.delete(ns)
    this._inFlight.delete(ns)
  }

  /** Drop every entry in `ttl` namespaces (post-mutation refresh). Immutable
   *  namespaces are content-addressed and stay. */
  invalidateWorkspace(): void {
    for (const [ns, policy] of this._policies) {
      if (policy.kind === 'ttl') this.invalidateNamespace(ns)
    }
  }

  /** Drop ttl-namespace entries whose key mentions `needle` (a depot or local
   *  path), for single-file operations. Immutable entries stay. */
  invalidateFile(needle: string): void {
    for (const [ns, policy] of this._policies) {
      if (policy?.kind !== 'ttl') continue
      const keys = new Set([
        ...(this._store.get(ns)?.keys() ?? []),
        ...(this._inFlight.get(ns)?.keys() ?? []),
      ])
      for (const key of keys) {
        if (key.includes(needle)) this.invalidate(ns, key)
      }
    }
  }

  /** Drop everything (e.g. going offline / disposing). */
  clear(): void {
    this._store.clear()
    this._inFlight.clear()
    this._namespaceGenerations.clear()
    this._keyGenerations.clear()
    this._generation++
  }

  private _read(ns: string, key: string, policy: P4CachePolicy): string | undefined {
    const entries = this._store.get(ns)
    const entry = entries?.get(key)
    if (entry) {
      if (entry.expiresAt === undefined || entry.expiresAt > this._now()) return entry.value
      entries!.delete(key) // expired
    }
    // Immutable entries can be served from the persistent backend on a cold cache
    // (unless the namespace opted out of persistence).
    if (policy.kind === 'immutable' && policy.persist !== false && this._disk) {
      const disk = this._disk.get(ns, key)
      if (disk !== undefined) {
        this._put(ns, key, { value: disk, expiresAt: undefined })
        return disk
      }
    }
    return undefined
  }

  private _write(ns: string, key: string, value: string, policy: P4CachePolicy): void {
    const expiresAt = policy.kind === 'ttl' ? this._now() + policy.ttlMs : undefined
    this._put(ns, key, { value, expiresAt })
    if (policy.kind === 'immutable' && policy.persist !== false && this._disk)
      this._disk.set(ns, key, value)
  }

  private _put(ns: string, key: string, entry: Entry): void {
    let entries = this._store.get(ns)
    if (!entries) {
      entries = new Map()
      this._store.set(ns, entries)
    }
    entries.set(key, entry)
  }
}

/** Namespace identifiers. New cached commands add a member here + a policy in
 *  {@link registerP4CacheNamespaces}. */
export const P4CacheNs = {
  /** `describe -s <submittedCL>` — immutable submitted-change detail. */
  describe: 'describe',
  /** `print -q <depot>#<rev>` — immutable revision content. */
  print: 'print',
  /** `where <depotFiles>` — client-view mapping (stable while the view is). */
  where: 'where',
  /** Resolved depot→local paths for one *submitted* change's files, keyed by
   *  change id. Immutable within a session (a submitted change's file set never
   *  changes), so reopening the change never re-runs `p4 where` — but NOT
   *  persisted, since the mapping depends on the client view which can differ
   *  across sessions. */
  changeDetailPaths: 'changeDetailPaths',
  /** `opened` — files currently open in the workspace. */
  opened: 'opened',
  /** `changes -s submitted -m N //...` — the graph history list (grows). */
  changesSubmitted: 'changesSubmitted',
  /** `describe -S -s <pendingCL>` — mutable because a shelf can be replaced. */
  shelvedDescribe: 'shelvedDescribe',
  /** `describe -S -s <archiveShelfCL>` — immutable: an archive shelf is a
   *  content-addressed snapshot that never changes once recorded, so it caches
   *  forever and ignores force invalidation (unlike {@link shelvedDescribe}).
   *  In-memory only: the file list embeds depot→local paths (`p4 where`) which
   *  depend on the client view, so it isn't persisted across sessions. */
  archiveDescribe: 'archiveDescribe',
} as const

export type P4CacheNamespace = (typeof P4CacheNs)[keyof typeof P4CacheNs]

/** Register the standard p4 namespaces + policies on `cache`. `workspaceTtlMs`
 *  drives every mutable namespace so a single config knob tunes staleness. */
export function registerP4CacheNamespaces(cache: P4Cache, workspaceTtlMs: number): void {
  cache.register(P4CacheNs.describe, { kind: 'immutable' })
  cache.register(P4CacheNs.print, { kind: 'immutable' })
  cache.register(P4CacheNs.changeDetailPaths, { kind: 'immutable', persist: false })
  cache.register(P4CacheNs.where, { kind: 'ttl', ttlMs: Math.max(workspaceTtlMs, 30_000) })
  cache.register(P4CacheNs.opened, { kind: 'ttl', ttlMs: workspaceTtlMs })
  cache.register(P4CacheNs.shelvedDescribe, { kind: 'ttl', ttlMs: workspaceTtlMs })
  cache.register(P4CacheNs.archiveDescribe, { kind: 'immutable', persist: false })
  cache.register(P4CacheNs.changesSubmitted, {
    kind: 'ttl',
    ttlMs: Math.max(workspaceTtlMs, 20_000),
  })
}
