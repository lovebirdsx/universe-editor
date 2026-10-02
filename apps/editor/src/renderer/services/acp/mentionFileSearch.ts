/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Workspace file fuzzy search for the @-mention popover. Caches the file
 *  listing per workspace root so repeated keystrokes don't re-walk the tree
 *  on every IPC. Freshness is driven by the file watcher (a change event
 *  invalidates the cache); the TTL is only a backstop. Callers that can
 *  tolerate briefly-stale data use `peekWorkspaceFiles` to render the cached
 *  listing instantly while `loadWorkspaceFiles` revalidates in the background.
 *  The fuzzy match itself is intentionally simple: a case-insensitive
 *  subsequence match favouring shorter / earlier matches, which is "good
 *  enough" without a fuzzy-search dependency.
 *
 *  Returns relative-to-root entries: the absolute fsPath becomes the
 *  resource URI; the workspace-relative path is the display label inserted
 *  after `@` (and the popover detail).
 *
 *  Entry construction is chunked for large listings: the URIs stay precomputed
 *  (the per-keystroke scan reads them), but a hundred thousand joins no longer
 *  run as one synchronous long task on the input path — see
 *  `buildMentionEntries`.
 *--------------------------------------------------------------------------------------------*/
import {
  CancellationError,
  URI,
  type CancellationToken,
  type IFileSearchService,
} from '@universe-editor/platform'
import { compareByScoreThenPath, fuzzyMatchField } from '@universe-editor/workbench-ui'
import { BoundedCache } from '../memory/boundedCache.js'
import { pushPerfPhaseSample } from '../performance/perfPhases.js'
import { yieldToMain } from '../scheduling/yieldToMain.js'

export interface MentionFileEntry {
  /** Absolute file:// URI (the value stored on the AcpContentBlock.resource_link). */
  readonly uri: string
  /** Workspace-relative path with forward slashes, e.g. `src/main.ts`. */
  readonly relPath: string
  /** Basename for display, e.g. `main.ts`. */
  readonly name: string
}

/**
 * Exclusion inputs for the workspace walk. `dirNames` prunes big directories
 * during the walk by bare name; `excludeGlobs` applies the full glob set in
 * the main-process search service. Decoupled from DI so this helper stays
 * pure-testable.
 */
export interface MentionFileFilter {
  readonly dirNames: readonly string[]
  readonly excludeGlobs?: readonly string[]
  /**
   * Honour .gitignore / .ignore during the walk (`search.useIgnoreFiles`).
   * Absent = false, matching the behaviour from before the setting existed.
   */
  readonly useIgnoreFiles?: boolean
  /**
   * Wall-clock budget for the walk. The idle prewarm passes one so a
   * pathological tree cannot spend minutes enumerating files nobody is
   * waiting for; expiry yields an empty listing flagged `limitHit` (the partial
   * subset is dropped main-side, see `omitTruncatedListing`).
   */
  readonly timeoutMs?: number
}

/**
 * Focus-mode inputs for the workspace walk: the folders narrow the enumeration
 * to ripgrep positional arguments, and the fingerprint partitions the cache so
 * a scope change never serves a listing walked under a different scope.
 */
export interface MentionFileFocus {
  readonly scanPaths?: readonly string[]
  readonly rootFilesInScope: boolean
  readonly fingerprint: string
}

/** Derive the mention focus inputs from a focus-scope-shaped source. */
export function focusScopeForMention(scope: {
  readonly active: boolean
  readonly scanPaths: readonly string[]
  readonly rootFilesInScope: boolean
  readonly fingerprint: string
}): MentionFileFocus {
  return {
    // Forward the array even when empty: active-with-nothing-scannable is not
    // unfocused, which is what omitting the property would mean downstream.
    ...(scope.active ? { scanPaths: [...scope.scanPaths] } : {}),
    rootFilesInScope: scope.rootFilesInScope,
    fingerprint: scope.fingerprint,
  }
}

const FALLBACK_IGNORE_DIRS = ['node_modules', '.git', 'dist', 'out', 'build', '.next', '.turbo']
const MAX_FILES = 100_000
// Backstop only: day-to-day freshness comes from the file watcher invalidating
// the cache on change events, so the TTL can be generous. A stale entry is still
// returned instantly (stale-while-revalidate) — see peekWorkspaceFiles.
const CACHE_TTL_MS = 5 * 60_000

/** The cached workspace listing plus whether the walk saw the whole tree.
 *  `complete: false` means the walk stopped early (MAX_FILES / timeout); the
 *  truncated subset is dropped main-side, so `entries` is empty and consumers
 *  that must find *any* file (e.g. Ctrl+P) rely on the fallback search alone. */
export interface WorkspaceFileListing {
  readonly entries: readonly MentionFileEntry[]
  readonly complete: boolean
}

interface _Cache {
  readonly key: string
  readonly listing: WorkspaceFileListing
  readonly timestamp: number
}

/**
 * Entries and bytes are both capped, and the cap is what actually bounds this cache.
 * The key carries the focus fingerprint, so every scope change is a new key and the
 * TTL alone never removed anything: a session that walked the tree focused and then
 * unfocused kept every listing for the life of the window. One listing is up to
 * `MAX_FILES` paths with a precomputed URI each, so the ceiling is not theoretical.
 */
const MAX_CACHED_LISTINGS = 4
const MAX_CACHED_LISTING_BYTES = 192 * 1024 * 1024

function measureListing(entry: _Cache): number {
  let bytes = 0
  for (const file of entry.listing.entries) {
    bytes += (file.uri.length + file.relPath.length + file.name.length) * 2
  }
  return bytes
}

const _cache = new BoundedCache<_Cache>(
  measureListing,
  MAX_CACHED_LISTINGS,
  MAX_CACHED_LISTING_BYTES,
)

/**
 * Cache-write admission. A load may publish its listing only while it still speaks for
 * the state it walked under, which two gates decide at completion:
 *
 * - `_generation` covers the invalidations that speak for *every* key — a global clear
 *   and a memory release both mean "what the cache holds is no longer wanted", so every
 *   walk already in flight loses the right to refill it.
 * - `_newestLoadByKey` gives each key a "newest request wins" slot: an older load that
 *   finishes after a newer one must not clobber the newer listing. A per-root
 *   invalidation consumes that right only for the keys it actually covers (see
 *   `invalidateMentionFileCache`), so unrelated roots keep caching. Map entries are
 *   claimed on start and released by their owner on completion — bounded by the number
 *   of loads in flight, never by how many distinct keys a session touched.
 */
let _generation = 0
let _loadSeq = 0
const _newestLoadByKey = new Map<string, number>()

/** Bytes the cached listings hold, for the memory-pressure waterline. */
export function mentionFileCacheStats(): { entries: number; bytes: number } {
  const stats = _cache.stats()
  return { entries: stats.entries, bytes: stats.bytes }
}

/** Release cached listings oldest-first until under `maxBytes`. Returns bytes freed.
 *  Bumps the generation: a release is an explicit demand for memory, and a walk
 *  already in flight must not immediately put a listing back into the cache that
 *  was just asked to give memory up. */
export function releaseMentionFileCache(maxBytes: number): number {
  _generation++
  return _cache.releaseTo(maxBytes)
}

function cacheKey(
  root: URI,
  dirNames: readonly string[],
  excludeGlobs: readonly string[],
  fingerprint: string,
  useIgnoreFiles: boolean,
): string {
  return (
    root.toString() +
    '|' +
    dirNames.join(',') +
    '|' +
    excludeGlobs.join(',') +
    '|' +
    fingerprint +
    // Part of the key: the two settings yield different file sets, so one cached
    // listing must not be shared across them.
    '|' +
    String(useIgnoreFiles)
  )
}

// 分片构造上界：十万条路径的 URI 预计算若一次同步跑完，就是输入路径上的一个长任务
// （每条都要 joinPath + toString + 取 basename）；分片让出把「最多阻塞多久」钉在一个
// 上限内，同时保留「URI 预计算」这个热路径前提（见 loadWorkspaceFiles 内注释）。
const BUILD_SLICE_MAX_ENTRIES = 1_024
const BUILD_SLICE_TIME_CHECK_EVERY = 256
const BUILD_SLICE_BUDGET_MS = 8
/** A whole listing load must take this long before its async wall is worth recording. */
const LOAD_WALL_SLOW_MS = 50

/** One listing entry. The URI is precomputed here, not lazily derived, because
 *  FileQuickAccessProvider's per-keystroke scan reads `entry.uri` for the whole
 *  pool — deriving it on the hot path would cost a join per entry per keystroke. */
function createMentionEntry(root: URI, relPath: string): MentionFileEntry {
  return {
    uri: URI.joinPath(root, relPath).toString(),
    relPath,
    name: relPath.slice(relPath.lastIndexOf('/') + 1),
  }
}

/**
 * Construct entries for `relPaths[from…]` into `entries` (in place, same index
 * order) until a slice bound is hit, and return the resume index. Bounds: at
 * most `BUILD_SLICE_MAX_ENTRIES` entries per call, and an early stop once the
 * `budgetMs` budget is spent at a check every `BUILD_SLICE_TIME_CHECK_EVERY`
 * entries. Synchronous on purpose — the async caller checks cancellation and
 * yields between slices; `now` is injectable so tests drive the budget
 * deterministically.
 */
export function buildMentionEntrySlice(
  root: URI,
  relPaths: readonly string[],
  from: number,
  entries: MentionFileEntry[],
  now: () => number = () => performance.now(),
  budgetMs: number = BUILD_SLICE_BUDGET_MS,
): number {
  const sliceStarted = now()
  const end = Math.min(from + BUILD_SLICE_MAX_ENTRIES, relPaths.length)
  let i = from
  while (i < end) {
    entries[i] = createMentionEntry(root, relPaths[i]!)
    i++
    if ((i - from) % BUILD_SLICE_TIME_CHECK_EVERY === 0 && now() - sliceStarted >= budgetMs) break
  }
  return i
}

/**
 * Chunked entry construction. Every listing — small ones included — is built slice by
 * slice under the same time budget, so "how long may this block the input path" is
 * bounded by the budget rather than by the listing size; the overwhelmingly common
 * small listing simply finishes inside its first slice, and a completed build never
 * yields. Large listings are built across slices with a real yield to the event loop
 * in between, so a pending input event or paint runs while a hundred thousand URIs are
 * still being joined.
 *
 * Cancellation is checked at every slice boundary: a cancelled build stops early and
 * rejects with `CancellationError` (the token contract used across IPC calls). It must
 * not resolve with a half listing that callers would take for the workspace, nor
 * publish one to the cache.
 *
 * `timing` is a test seam: `now` drives both the budget checks and the per-slice phase
 * spans, so the observation below is assertable without a real clock.
 */
export async function buildMentionEntries(
  root: URI,
  relPaths: readonly string[],
  token?: CancellationToken,
  timing: {
    readonly now?: () => number
    readonly budgetMs?: number
    readonly slowMs?: number
  } = {},
): Promise<MentionFileEntry[]> {
  const now = timing.now ?? ((): number => performance.now())
  const budgetMs = timing.budgetMs ?? BUILD_SLICE_BUDGET_MS
  const slowMs = timing.slowMs ?? BUILD_SLICE_BUDGET_MS
  if (token?.isCancellationRequested) throw new CancellationError()
  const entries = new Array<MentionFileEntry>(relPaths.length)
  let built = 0
  while (built < relPaths.length) {
    if (token?.isCancellationRequested) throw new CancellationError()
    const sliceStarted = now()
    const sliceEnd = buildMentionEntrySlice(root, relPaths, built, entries, now, budgetMs)
    const sliceMs = now() - sliceStarted
    // 超预算的分片各自记一条**真实起止**的相位——它描述的是这一小段同步阻塞，而不是
    // 把各分片耗时累加成一条横跨让出间隙的伪连续 span（那种 span 的 duration 与
    // start 对不上任何一段真实阻塞）。小块清单通常一条都不记。
    if (sliceMs >= slowMs) {
      pushPerfPhaseSample(
        `mentionFileSearch.buildSlice ${sliceEnd - built} entries`,
        sliceStarted,
        sliceMs,
      )
    }
    built = sliceEnd
    // 已完成就不让出：小清单零额外调度，大清单在分片边界把主线程交还出去。
    if (built < relPaths.length) await yieldToMain()
  }
  return entries
}

/**
 * Walk the workspace under `root` (cached). Returns at most `MAX_FILES`
 * entries with workspace-relative `relPath`. The cache key is the URI string
 * plus the exclude signature plus the focus fingerprint; each entry is
 * normalized to use forward slashes regardless of the host OS so the displayed
 * mention is stable across platforms.
 */
export async function loadWorkspaceFiles(
  root: URI,
  fileSearch: IFileSearchService,
  filter?: MentionFileFilter,
  token?: CancellationToken,
  focus?: MentionFileFocus,
): Promise<WorkspaceFileListing> {
  const dirNames = filter ? filter.dirNames : FALLBACK_IGNORE_DIRS
  const excludeGlobs = filter?.excludeGlobs ?? []
  const fingerprint = focus?.fingerprint ?? ''
  const useIgnoreFiles = filter?.useIgnoreFiles === true
  const key = cacheKey(root, dirNames, excludeGlobs, fingerprint, useIgnoreFiles)
  const now = Date.now()
  const cached = _cache.get(key)
  if (cached && now - cached.timestamp < CACHE_TTL_MS) return cached.listing
  const wallStartedAt = performance.now()

  // 请求代次与缓存世代都在 walk 开始前捕获：途中到达的失效/释放、或同一键上更新
  // 的请求，都会让这次 walk 失去回灌缓存的资格（见 _generation 注释）。
  const generation = _generation
  const requestSeq = ++_loadSeq
  _newestLoadByKey.set(key, requestSeq)
  try {
    const complete = await fileSearch.search(
      {
        root,
        pattern: '',
        matchAll: true,
        excludes: excludeGlobs,
        ignore: dirNames,
        maxResults: MAX_FILES,
        useIgnoreFiles,
        // 被 maxResults 截断说明这是巨型工作区：残缺子集会让模糊过滤把"子集外"
        // 显示成"搜不到"，而十万条路径本身也要跨 IPC 堵住 renderer 主线程。
        // 丢弃后由 FileQuickAccessProvider 的击键兜底搜索接管。
        omitTruncatedListing: true,
        ...(filter?.timeoutMs !== undefined ? { timeoutMs: filter.timeoutMs } : {}),
        // An explicitly empty scanPaths is "focused on nothing yet" and must
        // reach the main side as [] — dropping it would re-scan the whole tree.
        ...(focus?.scanPaths !== undefined ? { scanPaths: focus.scanPaths } : {}),
        ...(focus ? { rootFilesInScope: focus.rootFilesInScope } : {}),
      },
      token,
    )
    // uri 预计算而非惰性派生：FileQuickAccessProvider 的 scanPool 每次击键都要对
    // 整个池读 entry.uri 做编辑器去重，把派生搬进热路径会得不偿失。
    const relPaths = 'relPaths' in complete ? complete.relPaths : []
    const entries = await buildMentionEntries(root, relPaths, token)
    const listing: WorkspaceFileListing = { entries, complete: !complete.limitHit }
    // 异步墙钟（含 IPC 等待与分片让出）单独记录，名称自明不是 CPU 占用：慢交互
    // 报告据此归因"卡顿期间清单加载在途"，而不是把它当成同步阻塞。只记慢的——
    // 每次击键都落一条会让这条量淹没在常态噪声里。
    const wallMs = performance.now() - wallStartedAt
    if (wallMs >= LOAD_WALL_SLOW_MS) {
      pushPerfPhaseSample(
        'mentionFileSearch.loadWall (ipc + awaits, not cpu)',
        wallStartedAt,
        wallMs,
      )
    }
    // A cancelled walk returns whatever partial listing it had; caching it would
    // serve an arbitrarily truncated workspace for the whole TTL. A walk the
    // caller already superseded — a global clear or release (generation bumped), a
    // per-root invalidation (its slot below was stripped), or a newer load for the
    // same key (slot replaced) — must not refill the cache it no longer speaks for.
    if (
      complete.stopReason !== 'canceled' &&
      _generation === generation &&
      _newestLoadByKey.get(key) === requestSeq
    ) {
      _cache.set(key, { key, listing, timestamp: now })
    }
    return listing
  } finally {
    // 自己的入场券自己回收；被更新的请求取代时（值已不是本代次）留给它清理。
    if (_newestLoadByKey.get(key) === requestSeq) _newestLoadByKey.delete(key)
  }
}

/**
 * Return the cached listing for `root` without triggering a walk — including
 * past-TTL (stale) entries. Lets a picker render the previous listing instantly
 * while `loadWorkspaceFiles` revalidates in the background (stale-while-
 * revalidate). Returns undefined when nothing was ever cached for this root.
 */
export function peekWorkspaceFiles(
  root: URI,
  filter?: MentionFileFilter,
  focus?: MentionFileFocus,
): WorkspaceFileListing | undefined {
  const dirNames = filter ? filter.dirNames : FALLBACK_IGNORE_DIRS
  const excludeGlobs = filter?.excludeGlobs ?? []
  const fingerprint = focus?.fingerprint ?? ''
  return _cache.get(
    cacheKey(root, dirNames, excludeGlobs, fingerprint, filter?.useIgnoreFiles === true),
  )?.listing
}

/** Keys are `<rootUri>|<dirNameSignature>…` and `URI.toString()` percent-encodes
 *  `|`, so the root segment always ends at the first literal separator. */
function rootSegmentOf(key: string): string {
  const end = key.indexOf('|')
  return end === -1 ? key : key.slice(0, end)
}

/**
 * Whether `candidate` is `root` or a root walked beneath it. Case is folded on
 * purpose: the same directory can reach the cache spelled `C:/repo/sub` from a
 * session cwd and `c:/repo/sub` from a folder URI, and a case-sensitive *miss*
 * would leave that listing stale for the whole TTL — a folded *hit* only costs
 * one re-walk.
 */
function isSameOrDescendantRoot(candidate: string, root: string): boolean {
  const base = root.toLowerCase()
  const other = candidate.toLowerCase()
  // A `file:///` root already ends in the separator; adding another never matches.
  return other === base || other.startsWith(base.endsWith('/') ? base : `${base}/`)
}

/**
 * Invalidate the cache — exposed for tests and for explicit refresh actions.
 * Descendant roots go with it: file changes are reported against the workspace
 * root, but a session rooted at a subdirectory holds its own cache entry that
 * would otherwise survive every invalidation and stay stale for the whole TTL.
 *
 * A per-root invalidation also strips the *right to publish* from exactly the loads it
 * covers, and only those: deleting their `_newestLoadByKey` slot makes the completion
 * identity check fail, so a walk that began before the change cannot refill the cache it
 * no longer speaks for. It deliberately does not bump the global generation — that would
 * strand walks of unrelated roots, which have every right to publish their listings. The
 * no-argument form (and a memory release) speaks for every key and bumps the generation
 * instead.
 */
export function invalidateMentionFileCache(root?: URI): void {
  if (!root) {
    _generation++
    _cache.clear()
    return
  }
  const target = root.toString()
  for (const key of [..._cache.keys()]) {
    if (isSameOrDescendantRoot(rootSegmentOf(key), target)) _cache.delete(key)
  }
  for (const key of [..._newestLoadByKey.keys()]) {
    if (isSameOrDescendantRoot(rootSegmentOf(key), target)) _newestLoadByKey.delete(key)
  }
}

/**
 * Fuzzy-match `entries` against the user's query. Empty query returns the
 * first `limit` entries unchanged. Each match is scored by:
 *   - prefix match on basename → highest priority
 *   - substring match on basename → next
 *   - subsequence match on relPath → lowest
 * Entries that don't match at all are filtered out.
 */
export function filterMentionFiles(
  entries: readonly MentionFileEntry[],
  query: string,
  limit = 30,
): readonly MentionFileEntry[] {
  if (!query) return entries.slice(0, limit)
  const q = query.toLowerCase()
  const scored: { entry: MentionFileEntry; score: number }[] = []
  for (const entry of entries) {
    const name = entry.name.toLowerCase()
    const rel = entry.relPath.toLowerCase()
    let score = -1
    if (name.startsWith(q)) score = 1000 - name.length
    else if (name.includes(q)) score = 500 - name.length
    else if (rel.includes(q)) score = 200 - rel.length
    else if (fuzzyMatchField(entry.relPath, query)) score = 50
    if (score >= 0) scored.push({ entry, score })
  }
  scored.sort((a, b) => compareByScoreThenPath(a.score, b.score, a.entry.relPath, b.entry.relPath))
  return scored.slice(0, limit).map((s) => s.entry)
}
