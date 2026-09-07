/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Default quick access (no prefix): Go to File. With a workspace open it warms
 *  the full file list once when the picker opens (reusing the @-mention file
 *  cache) and then filters it in-memory on every keystroke — no per-keystroke
 *  disk walk. Large listings score in time-sliced chunks off the input event,
 *  and every completed scan narrows the candidate pool for the next extending
 *  keystroke (fuzzy matches are subsequence-based, so extending the query can
 *  only shrink the match set) — huge workspaces stay responsive too. When the
 *  warm-up walk could not see the whole tree (listing truncated at the cache
 *  cap), each keystroke additionally runs a scored main-process search and
 *  merges the hits, so files outside the cached subset remain findable.
 *  Open editors and views interleave by recency at the head of the empty-query
 *  list — the target the user just worked in (file OR view) outranks everything
 *  else, mirroring Ctrl+Tab's MRU. Both kinds also join fuzzy matching while
 *  typing; fuzzy-equal view rows keep their MRU order rather than falling back
 *  to alphabetical. With no workspace the picker falls back to the recent files
 *  list. Mirrors VSCode's file quick access, whose cached-listing fast path is
 *  what keeps typing responsive on large trees.
 *--------------------------------------------------------------------------------------------*/

import {
  CancellationTokenSource,
  EditorRegistry,
  GroupDirection,
  IEditorGroupsService,
  IEditorResolverService,
  IFileSearchService,
  IFileService,
  IInstantiationService,
  ILayoutService,
  ILoggerService,
  IUriIdentityService,
  IViewDescriptorService,
  IWorkspaceService,
  URI,
  createNamedLogger,
  localize,
  toDisposable,
  type ILogger,
  type IQuickAccessProvider,
  type IQuickAccessProviderRunOptions,
  type IQuickPick,
  type IQuickPickItem,
  type IEditorGroup,
} from '@universe-editor/platform'
import { compareByScoreThenPath, scoreFuzzyMatch } from '@universe-editor/workbench-ui'
import { recordPerfPhase, recordPerfPhaseAsync } from '../../performance/perfPhases.js'
import { isFileSystemUri } from '../../files/fileSystemScheme.js'
import { IRecentFilesService } from '../../recentFiles/recentFilesService.js'
import { IExcludeService } from '../../exclude/ExcludeService.js'
import {
  loadWorkspaceFiles,
  peekWorkspaceFiles,
  focusScopeForMention,
  type MentionFileEntry,
  type MentionFileFilter,
} from '../../acp/mentionFileSearch.js'
import { IFocusScopeService } from '../../focus/FocusScopeService.js'
import {
  decodeEditorPickId,
  decodeViewPickId,
  encodeEditorPickId,
  encodeViewPickId,
  IRecentTargetsService,
} from '../../editor/RecentTargetsService.js'
import { IClosedEditorsService } from '../../editor/ClosedEditorsService.js'
import { resourceIconId } from '../quickPickResourceIcon.js'
import { createViewPickItem } from '../viewQuickPick.js'

const GO_TO_FILE_MAX_RESULTS = 512
// Above this pool size the per-keystroke scan leaves the input event and runs
// in time-sliced chunks: scoring a 100k-entry listing costs 100-200ms, which as
// a synchronous onDidChangeValue reaction blocks every quick-open keystroke
// (measured on a 4.3M-file workspace via the interaction perf collect spec).
const SYNC_FILTER_LIMIT = 5_000
const CHUNK_BUDGET_MS = 8
// Mid-scan row-compaction bound: rows dropped by a compaction rank below the
// kept top slice under a static comparator, so the final top results are
// unaffected — this only bounds the final sort.
const COMPACT_ROWS_AT = 8_192
// 截断清单的兜底搜索按击键防抖：连续输入时只有停顿后的最终 pattern 会真正
// 打到主进程（上一次在飞的搜索由 seq/CTS 取消），避免每个字符都 spawn rg。
const FALLBACK_DEBOUNCE_MS = 200

const yieldToMain = (): Promise<void> => {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  return scheduler?.yield?.() ?? new Promise((resolve) => setTimeout(resolve, 0))
}

/** A scored filter hit: either an open-editor pick or a file listing entry. */
interface ScoredRow {
  readonly score: number
  readonly path: string
  readonly pick?: IQuickPickItem
  readonly entry?: MentionFileEntry
  /** Set only on view rows: index within `getRecentViews()`. Tie-breaker when
   *  two view rows score equally so MRU order survives the fuzzy sort. */
  readonly viewRank?: number
}

/** Fuzzy-row comparator. Score first; when two view rows tie, prefer the one
 *  more recently used (lower `viewRank`); otherwise fall back to the standard
 *  path comparator. */
function compareScoredRows(a: ScoredRow, b: ScoredRow): number {
  if (a.score !== b.score) return b.score - a.score
  if (a.viewRank !== undefined && b.viewRank !== undefined) return a.viewRank - b.viewRank
  return compareByScoreThenPath(a.score, b.score, a.path, b.path)
}

/** 绝对路径显示：file: 用 fsPath 折 Windows 盘符，非 file:（远端资源）用其 path 段。 */
function displayPath(uri: URI): string {
  return uri.scheme === 'file' ? uri.fsPath : uri.path
}

function workspaceRelativePath(root: URI, uri: URI): string {
  if (root.scheme !== uri.scheme || root.authority !== uri.authority) return displayPath(uri)
  const rootPath = root.path.replace(/\/$/, '')
  const norm = uri.path
  return norm.startsWith(rootPath + '/') ? norm.slice(rootPath.length + 1) : displayPath(uri)
}

function editorPickDescription(root: URI | undefined, resource: URI): string | undefined {
  return resource.scheme === 'file'
    ? root
      ? workspaceRelativePath(root, resource)
      : resource.fsPath
    : undefined
}

function createFilePick(root: URI, uri: URI, labelOverride?: string): IQuickPickItem {
  const rel = workspaceRelativePath(root, uri)
  const label = labelOverride ?? rel.split(/[/\\]/).at(-1) ?? displayPath(uri)
  return { id: uri.toString(), label, description: rel, iconId: resourceIconId(uri) }
}

/** An open editor or a view as a pick candidate: the pick itself plus the
 *  strings the fuzzy scorer matches against (label + path, mirroring file
 *  entries). */
interface EditorPickCandidate {
  readonly pick: IQuickPickItem
  readonly name: string
  readonly path: string
  /** Index within `IRecentTargetsService.getRecentViews()` — set only on view
   *  candidates. Used as the tie-breaker when two view rows score equally in a
   *  fuzzy match so the picker keeps the MRU order the tracker produced. */
  readonly viewRank?: number
}

function hasPathSeparator(value: string): boolean {
  return value.includes('/') || value.includes('\\')
}

/**
 * Score a file against the query. Whitespace splits the query into pieces that
 * must all match; a basename hit outranks a path-only hit (the +2000 tier). This
 * mirrors the ranking the previous main-process search used, so results order the
 * same way now that filtering happens in the renderer over the cached listing.
 */
function scoreFileMatch(basename: string, relativePath: string, pattern: string): number {
  const pieces = pattern
    .trim()
    .replace(/\\/g, '/')
    .split(/\s+/)
    .filter((piece) => piece.length > 0)
  if (pieces.length === 0) return -1

  let total = 0
  for (const piece of pieces) {
    const basenameScore = scoreFuzzyMatch(basename, piece)
    const pathScore = scoreFuzzyMatch(relativePath, piece)
    const score = Math.max(
      basenameScore >= 0 ? basenameScore + 2000 : -1,
      pathScore >= 0 ? pathScore : -1,
    )
    if (score < 0) return -1
    total += score
  }
  return total
}

function entryToPick(entry: MentionFileEntry): IQuickPickItem {
  const resource = URI.parse(entry.uri)
  return {
    id: entry.uri,
    label: entry.name,
    description: entry.relPath,
    iconId: resourceIconId(resource),
  }
}

export class FileQuickAccessProvider implements IQuickAccessProvider {
  private readonly _logger: ILogger

  constructor(
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IFileSearchService private readonly _fileSearch: IFileSearchService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IRecentFilesService private readonly _recentFiles: IRecentFilesService,
    @IExcludeService private readonly _exclude: IExcludeService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
    @IEditorResolverService private readonly _editorResolver: IEditorResolverService,
    @IFileService private readonly _fileService: IFileService,
    @IRecentTargetsService private readonly _recentTargets: IRecentTargetsService,
    @IClosedEditorsService private readonly _closedEditors: IClosedEditorsService,
    @IViewDescriptorService private readonly _viewDescriptors: IViewDescriptorService,
    @ILayoutService private readonly _layout: ILayoutService,
    @IInstantiationService private readonly _inst: IInstantiationService,
    @ILoggerService loggerService: ILoggerService,
    @IFocusScopeService private readonly _focus: IFocusScopeService,
  ) {
    this._logger = createNamedLogger(loggerService, { id: 'quickOpen', name: 'Quick Open' })
  }

  provide(picker: IQuickPick<IQuickPickItem>, options: IQuickAccessProviderRunOptions): void {
    const root = this._workspace.current?.folder
    if (root) this._provideWorkspace(picker, options, root)
    else this._provideRecentOnly(picker, options)
  }

  /** Snapshot the currently open editors (all types, MRU order) as pick
   *  candidates, followed by recently closed editors that can be restored with
   *  their exact type (same path as Reopen Closed Editor). Resource-backed
   *  editors reuse the resource URI as pick id so they dedupe against file
   *  entries and activate through `_open`; purely virtual editors (Settings,
   *  Welcome, terminals…) get an encoded (groupId, editorId) id that
   *  `_acceptPick` resolves to a live activation. */
  private _buildEditorCandidates(root: URI | undefined): EditorPickCandidate[] {
    const out: EditorPickCandidate[] = []
    const seen = new Set<string>()
    // Views are switch targets too, but they are built separately
    // (`_buildViewCandidates`) so only the editor half seeds the empty query.
    for (const target of this._recentTargets.getRecentTargets()) {
      if (target.kind !== 'editor') continue
      const { editor, group } = target
      const resource = editor.resource
      const id = resource ? resource.toString() : encodeEditorPickId(group.id, editor.id)
      if (seen.has(id)) continue
      seen.add(id)
      const iconId = editor.getIconId?.() ?? (resource ? resourceIconId(resource) : undefined)
      const description = resource ? editorPickDescription(root, resource) : undefined
      out.push({
        pick: {
          id,
          label: editor.label,
          ...(description ? { description } : {}),
          ...(iconId ? { iconId } : {}),
        },
        name: editor.label,
        path: description ?? editor.label,
      })
    }
    // Recently closed editors stay listed so a closed custom/image/preview tab
    // can be picked again; `_open` restores them with their exact typeId.
    // Entries whose type has no deserialize hook (terminals…) are unrestorable
    // and skipped. The pick id is the resource URI, so a closed entry sharing
    // a resource with an open editor collapses into that editor's pick — the
    // closed-first restore in `_open` still reopens the closed type.
    for (const entry of this._closedEditors.getClosedEditors()) {
      const id = entry.resource.toString()
      if (seen.has(id)) continue
      if (!EditorRegistry.getProvider(entry.typeId)?.deserialize) continue
      seen.add(id)
      const description = editorPickDescription(root, entry.resource)
      const iconId = resourceIconId(entry.resource)
      out.push({
        pick: {
          id,
          label: entry.label,
          ...(description ? { description } : {}),
          ...(iconId ? { iconId } : {}),
        },
        name: entry.label,
        path: description ?? entry.label,
      })
    }
    return out
  }

  /** Visible views (MRU order) as pick candidates. Matched against the view name
   *  and its container label, so "term" finds Terminal and "panel" is not
   *  required to know which container a view lives in. Each candidate carries
   *  its MRU index so fuzzy-equal view rows keep the recency order. */
  private _buildViewCandidates(): EditorPickCandidate[] {
    return this._recentTargets.getRecentViews().map((descriptor, index) => {
      const pick = createViewPickItem(descriptor, this._viewDescriptors)
      return { pick, name: pick.label, path: pick.description ?? pick.label, viewRank: index }
    })
  }

  /** Activate the editor if already open in any group, else open it via the
   *  editor resolver so contributed custom editors (e.g. the PDF viewer) win over
   *  the plain text editor — mirroring how the Explorer opens files. Virtual
   *  (non-file) resources never reach the resolver: it would fall back to a
   *  FileEditorInput that renders empty and is labelled by the URI basename
   *  (e.g. a session guid) — they either restore from the closed stack, activate
   *  an already-open tab, or do nothing. With `openToSide` (Ctrl/Alt+Enter), the
   *  target is the group to the right of the active one (created when absent)
   *  and dedupe happens only within it, so a file already open elsewhere gets a
   *  second copy — mirroring VSCode's SIDE_GROUP quick open semantics. */
  private _open(
    uri: URI,
    label: string,
    opts: { addRecent: boolean; pinned: boolean; openToSide: boolean },
  ): void {
    if (opts.addRecent) this._recentFiles.add(uri, label)
    if (opts.openToSide) {
      const active = this._groups.activeGroup
      let side = this._groups.findGroup({ direction: GroupDirection.Right }, active, true)
      if (!side || side === active) side = this._groups.addGroup(active, GroupDirection.Right)
      this._groups.activateGroup(side)
      for (const editor of side.editors) {
        if (editor.resource && this._uriIdentity.isEqual(editor.resource, uri)) {
          side.setActive(editor)
          return
        }
      }
      if (this._restoreClosed(uri, side, true)) return
      this._openThroughResolver(uri, true)
      return
    }
    // Closed-first: a just-closed editor (custom/image/preview) is restored with
    // its exact type even when another editor of the same file is still open —
    // otherwise the surviving text tab would "intercept" the pick and the closed
    // image/custom tab could never be brought back through quick open.
    if (this._restoreClosed(uri, undefined, opts.pinned)) return
    for (const group of this._groups.groups) {
      for (const editor of group.editors) {
        if (editor.resource && this._uriIdentity.isEqual(editor.resource, uri)) {
          this._groups.activateGroup(group)
          group.setActive(editor)
          return
        }
      }
    }
    this._openThroughResolver(uri, opts.pinned)
  }

  private _openThroughResolver(uri: URI, pinned: boolean): void {
    if (!isFileSystemUri(uri)) {
      this._logger.debug(`file quick open: skipping non-filesystem resource ${uri.toString()}`)
      return
    }
    void this._editorResolver.openEditor(uri, { pinned })
  }

  /** Restore a just-closed editor with its exact typeId via the closed-editors
   *  stack (same deserialize path as Reopen Closed Editor) instead of
   *  re-guessing the type through the resolver — the resolver can pick the
   *  wrong type for equal-priority custom editors and cannot handle virtual
   *  resources (markdown-preview:…) at all. Returns false when nothing
   *  restorable matches, or when deserialize fails (the consumed entry is then
   *  dropped, mirroring ReopenClosedEditorAction).
   *  The restored editor lands in the CURRENT active group (or openToSide's
   *  side group): stack entries persist across restarts, so `closed.groupId`
   *  can point at whichever group hosted the file long ago — quick open opens
   *  where the user's focus is; replaying the recorded position is Reopen
   *  Closed Editor's (Ctrl+Shift+T) job, not quick open's. */
  private _restoreClosed(
    uri: URI,
    targetGroup: IEditorGroup | undefined,
    pinned: boolean,
  ): boolean {
    const closed = this._closedEditors.takeMostRecentMatching(uri)
    if (!closed) return false
    const input = this._inst.invokeFunction((accessor) =>
      EditorRegistry.deserialize(closed.typeId, closed.serializedData, accessor),
    )
    if (!input) return false
    const group = targetGroup ?? this._groups.activeGroup
    this._groups.activateGroup(group)
    group.openEditor(input, { activate: true, pinned })
    return true
  }

  private _acceptPick(
    pick: IQuickPickItem | undefined,
    opts: { addRecent: boolean; pinned: boolean; openToSide: boolean },
  ): void {
    if (!pick) return
    const viewId = decodeViewPickId(pick.id)
    if (viewId !== undefined) {
      // focusView owns the whole reveal: active container, hosting part, and the
      // view's own collapsed state — no need to expand anything here first.
      void this._layout.focusView(viewId, { source: 'command' })
      return
    }
    const decoded = decodeEditorPickId(pick.id)
    if (decoded) {
      const group = this._groups.getGroup(decoded.groupId)
      const editor = group?.editors.find((e) => e.id === decoded.editorId)
      if (group && editor) {
        this._groups.activateGroup(group)
        group.setActive(editor)
      }
      return
    }
    this._open(URI.parse(pick.id), pick.label, opts)
  }

  private _provideWorkspace(
    picker: IQuickPick<IQuickPickItem>,
    options: IQuickAccessProviderRunOptions,
    root: URI,
  ): void {
    const { disposables, token } = options
    picker.filterExternally = true
    picker.placeholder = localize('quickInput.goToFile.placeholder', 'Go to File…')

    const focus = focusScopeForMention(this._focus)
    const filter: MentionFileFilter = {
      dirNames: this._exclude.getDirNameIgnores(),
      excludeGlobs: this._exclude.getSearchExcludeGlobs(),
      useIgnoreFiles: this._exclude.getUseIgnoreFiles(),
    }

    // Open editors (all types) and views interleave by recency at the head of
    // the empty-query list — the target the user just worked in outranks
    // everything else, mirroring Ctrl+Tab's MRU. Both kinds also participate in
    // fuzzy matching while typing; fuzzy-equal view rows keep their MRU order
    // rather than falling back to alphabetical.
    const editorCandidates = this._buildEditorCandidates(root)
    const viewCandidates = this._buildViewCandidates()
    const matchCandidates = [...editorCandidates, ...viewCandidates]

    // Index candidates by pick id so the empty-query list below can re-emit
    // them in `getRecentTargets()` recency order without rebuilding the pick.
    const candidateByPickId = new Map<string, IQuickPickItem>()
    for (const c of matchCandidates) candidateByPickId.set(c.pick.id, c.pick)

    let recentFileItems: readonly IQuickPickItem[] = []
    const emptyQueryItems = (): IQuickPickItem[] => {
      const headIds = new Set<string>()
      const head: IQuickPickItem[] = []
      for (const target of this._recentTargets.getRecentTargets()) {
        const id =
          target.kind === 'editor'
            ? (target.editor.resource?.toString() ??
              encodeEditorPickId(target.group.id, target.editor.id))
            : encodeViewPickId(target.descriptor.id)
        if (headIds.has(id)) continue
        const pick = candidateByPickId.get(id)
        if (!pick) continue
        headIds.add(id)
        head.push(pick)
      }
      // Candidates the MRU did not surface (e.g. recently closed editors —
      // restorable but never focused this session) keep their relative order
      // after the interleaved head, before the recent files.
      for (const c of matchCandidates) {
        if (!headIds.has(c.pick.id)) head.push(c.pick)
      }
      return [...head, ...recentFileItems.filter((it) => !headIds.has(it.id))].slice(
        0,
        GO_TO_FILE_MAX_RESULTS,
      )
    }
    // The cached full file listing (loaded once when the picker opens). Filtering
    // then runs in-memory on every keystroke — no per-keystroke disk walk.
    let allFiles: readonly MentionFileEntry[] | undefined
    // False when the warm-up walk stopped early (MAX_FILES / timeout): the pool
    // is an arbitrary subset of the workspace, so in-memory filtering alone
    // would permanently hide every file outside it.
    let listingComplete = true
    let seq = 0
    // The last fully-scanned pattern and the entries it matched. A keystroke
    // that extends that pattern only rescans this (usually far smaller) match
    // set — subsequence matching guarantees extending the query can only shrink
    // it. Reset whenever a fresh listing lands.
    let lastCompleted: { pattern: string; entries: readonly MentionFileEntry[] } | undefined

    // Fuzzy match over the open-editor and view candidates only — used both as
    // the non-file tier of the full filter and as the cold-cache fallback list.
    const matchEditors = (pattern: string): ScoredRow[] => {
      const hits: ScoredRow[] = []
      for (const cand of matchCandidates) {
        const score = scoreFileMatch(cand.name, cand.path, pattern)
        if (score < 0) continue
        hits.push({
          pick: cand.pick,
          score,
          path: cand.path,
          ...(cand.viewRank !== undefined ? { viewRank: cand.viewRank } : {}),
        })
      }
      return hits
    }

    // In-memory fuzzy filter over the candidate pool. Whitespace-separated pieces
    // must all match; a basename hit outranks a path hit; results are capped at 512.
    // Small pools filter synchronously inside the keystroke (zero added latency);
    // large pools scan in time-sliced chunks so the input event returns instantly.
    const sortRows = (rows: ScoredRow[]): void => {
      rows.sort(compareScoredRows)
    }
    const finalizeRows = (rows: ScoredRow[]): IQuickPickItem[] => {
      sortRows(rows)
      return rows.slice(0, GO_TO_FILE_MAX_RESULTS).map((r) => r.pick ?? entryToPick(r.entry!))
    }
    const editorRows = (pattern: string): { rows: ScoredRow[]; ids: Set<string> } => {
      const rows = matchEditors(pattern)
      const ids = new Set<string>()
      for (const r of rows) if (r.pick) ids.add(r.pick.id)
      return { rows, ids }
    }
    // Score `pool` from index `from` into rows/matched; stops once past
    // `deadline` (checked every 1024 entries). Returns the resume index.
    const scanPool = (
      pool: readonly MentionFileEntry[],
      from: number,
      pattern: string,
      editorIds: ReadonlySet<string>,
      rows: ScoredRow[],
      matched: MentionFileEntry[],
      deadline?: number,
    ): number => {
      for (let i = from; i < pool.length; i++) {
        if (deadline !== undefined && (i & 1023) === 1023 && performance.now() > deadline) return i
        const entry = pool[i]!
        if (editorIds.has(entry.uri)) continue
        const score = scoreFileMatch(entry.name, entry.relPath, pattern)
        if (score >= 0) {
          matched.push(entry)
          rows.push({ score, path: entry.relPath, entry })
        }
      }
      return pool.length
    }
    const candidatePool = (pattern: string): readonly MentionFileEntry[] =>
      lastCompleted && pattern.startsWith(lastCompleted.pattern)
        ? lastCompleted.entries
        : (allFiles ?? [])

    const filterPoolSync = (pattern: string, pool: readonly MentionFileEntry[]): ScoredRow[] => {
      const { rows, ids } = editorRows(pattern)
      const matched: MentionFileEntry[] = []
      scanPool(pool, 0, pattern, ids, rows, matched)
      lastCompleted = { pattern, entries: matched }
      return rows
    }

    // Chunked scan for large pools: abandons itself (returns undefined) when a
    // newer keystroke bumps `seq` or the picker is dismissed.
    const filterPoolChunked = async (
      pattern: string,
      pool: readonly MentionFileEntry[],
      mySeq: number,
    ): Promise<ScoredRow[] | undefined> => {
      const { rows, ids } = editorRows(pattern)
      const matched: MentionFileEntry[] = []
      let next = scanPool(pool, 0, pattern, ids, rows, matched, performance.now() + CHUNK_BUDGET_MS)
      while (next < pool.length) {
        if (rows.length > COMPACT_ROWS_AT) {
          sortRows(rows)
          rows.length = GO_TO_FILE_MAX_RESULTS
        }
        await yieldToMain()
        if (mySeq !== seq || token.isCancellationRequested) return undefined
        next = scanPool(
          pool,
          next,
          pattern,
          ids,
          rows,
          matched,
          performance.now() + CHUNK_BUDGET_MS,
        )
      }
      lastCompleted = { pattern, entries: matched }
      return rows
    }

    // Truncated-listing fallback: when the warm-up walk could not see the whole
    // tree, every keystroke also runs a scored main-process search (globally
    // top-K over the full walk, cancelled by the next keystroke) and merges the
    // hits — cached-pool results stay instant, files outside the cache become
    // findable again. Complete listings never pay this walk.
    let fallbackCts: CancellationTokenSource | undefined
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined
    let localRows: ScoredRow[] | undefined
    let fallbackRows: ScoredRow[] | undefined
    let fallbackPending = false
    disposables.add(
      toDisposable(() => {
        fallbackCts?.dispose(true)
        if (fallbackTimer !== undefined) clearTimeout(fallbackTimer)
      }),
    )

    const renderMerged = (pattern: string, mySeq: number): void => {
      if (mySeq !== seq || token.isCancellationRequested || localRows === undefined) return
      let rows = localRows
      if (fallbackRows !== undefined && fallbackRows.length > 0) {
        const seen = new Set(rows.map((r) => r.pick?.id ?? r.entry!.uri))
        rows = [...rows, ...fallbackRows.filter((r) => !seen.has(r.entry!.uri))]
      }
      const items = finalizeRows([...rows])
      picker.items = items
      picker.busy = fallbackPending
      void prependExactPathMatch(pattern, mySeq, items)
    }

    const runFallbackSearch = (pattern: string, mySeq: number): void => {
      if (listingComplete) return
      // busy 在防抖等待期就点亮：合并结果尚不完整，进度条如实反映。
      fallbackPending = true
      fallbackTimer = setTimeout(() => {
        fallbackTimer = undefined
        if (mySeq !== seq || token.isCancellationRequested) return
        const cts = new CancellationTokenSource(token)
        fallbackCts = cts
        void this._fileSearch
          .search(
            {
              root,
              pattern,
              maxResults: GO_TO_FILE_MAX_RESULTS,
              excludes: filter.excludeGlobs ?? [],
              ignore: filter.dirNames,
              useIgnoreFiles: this._exclude.getUseIgnoreFiles(),
              ...(focus.scanPaths ? { scanPaths: focus.scanPaths } : {}),
              rootFilesInScope: focus.rootFilesInScope,
            },
            cts.token,
          )
          .then((complete) => {
            if (mySeq !== seq || token.isCancellationRequested) return
            fallbackRows = complete.results.map((m) => ({
              score: m.score,
              path: m.relativePath,
              entry: { uri: m.resource.toString(), relPath: m.relativePath, name: m.basename },
            }))
          })
          .catch(() => undefined)
          .then(() => {
            if (mySeq !== seq) return
            fallbackPending = false
            renderMerged(pattern, mySeq)
          })
      }, FALLBACK_DEBOUNCE_MS)
    }

    // When the query looks like a path (contains a separator), probe the exact
    // file so `foo/bar.ts` opens even if it's outside the cached listing (mirrors
    // the previous includeExactPathMatches behaviour). Prepended above fuzzy hits.
    const prependExactPathMatch = async (
      pattern: string,
      mySeq: number,
      items: IQuickPickItem[],
    ): Promise<void> => {
      if (!hasPathSeparator(pattern)) return
      const normalized = pattern.replace(/\\/g, '/')
      const target =
        normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)
          ? URI.file(normalized)
          : URI.joinPath(root, normalized)
      const exists = await this._fileService.exists(target).catch(() => false)
      if (!exists || mySeq !== seq || token.isCancellationRequested) return
      const pick = createFilePick(root, target)
      const rest = items.filter((it) => it.id !== pick.id)
      picker.items = [pick, ...rest].slice(0, GO_TO_FILE_MAX_RESULTS)
    }

    const runSearch = (value: string): void => {
      // Emitter 是快照派发（VSCode parity）：前缀翻转的这次击键里，本监听器可能在
      // controller 已 dispose 本 provider 之后仍被本次 fire 调用。disposeActiveProvider
      // 先 cancel 再 dispose，所以 token 已 cancelled 意味着再写 picker 会覆盖新激活
      // provider 刚设置的状态（如重新输入 '>' 时命令列表被文件结果覆盖）。
      if (token.isCancellationRequested) return
      const mySeq = ++seq
      fallbackCts?.dispose(true)
      fallbackCts = undefined
      if (fallbackTimer !== undefined) {
        clearTimeout(fallbackTimer)
        fallbackTimer = undefined
      }
      localRows = undefined
      fallbackRows = undefined
      fallbackPending = false
      const pattern = value.trim()
      if (pattern.length === 0) {
        picker.busy = false
        picker.items = emptyQueryItems()
        return
      }
      if (allFiles === undefined) {
        // Listing not warmed yet: keep the spinner, but don't leave the user
        // staring at it — editor hits filter instantly, and a path-shaped query
        // is probed with a single stat (the warm-up below re-runs the current
        // query once files land, superseding these interim results).
        picker.busy = true
        const editorOnly = matchEditors(pattern)
          .sort(compareScoredRows)
          .slice(0, GO_TO_FILE_MAX_RESULTS)
          .flatMap((h) => (h.pick ? [h.pick] : []))
        picker.items = editorOnly
        void prependExactPathMatch(pattern, mySeq, editorOnly)
        return
      }
      const pool = candidatePool(pattern)
      runFallbackSearch(pattern, mySeq)
      if (pool.length <= SYNC_FILTER_LIMIT) {
        localRows = recordPerfPhase('quickOpen.filterFiles', () => filterPoolSync(pattern, pool))
        renderMerged(pattern, mySeq)
        return
      }
      picker.busy = true
      void recordPerfPhaseAsync('quickOpen.filterFiles', () =>
        filterPoolChunked(pattern, pool, mySeq),
      ).then((rows) => {
        if (rows === undefined || mySeq !== seq || token.isCancellationRequested) return
        localRows = rows
        renderMerged(pattern, mySeq)
      })
    }

    disposables.add(picker.onDidChangeValue(runSearch))
    disposables.add(
      picker.onDidAccept((items) => {
        const pick = items[0]
        const openToSide = picker.keyMods.ctrl || picker.keyMods.alt
        picker.hide()
        this._acceptPick(pick, { addRecent: true, pinned: true, openToSide })
      }),
    )
    disposables.add(toDisposable(() => seq++))

    // Editor picks are available synchronously — seed them before the async
    // recent-files list lands.
    if (picker.value.trim().length === 0) picker.items = emptyQueryItems()

    // Warm the full listing once (watcher-invalidated cache shared with
    // @-mention). Seed from the previous listing first — even a stale one beats
    // an empty picker — then revalidate in the background and re-run the
    // current query when fresh files land, so an early keystroke isn't lost.
    const cachedListing = peekWorkspaceFiles(root, filter, focus)
    allFiles = cachedListing?.entries
    listingComplete = cachedListing?.complete ?? true
    if (picker.value.trim().length > 0) {
      if (allFiles === undefined) picker.busy = true
      else runSearch(picker.value)
    }
    void loadWorkspaceFiles(root, this._fileSearch, filter, token, focus)
      .then((listing) => {
        if (token.isCancellationRequested) return
        allFiles = listing.entries
        listingComplete = listing.complete
        // The fresh listing may contain files the stale scan never saw — the
        // narrowing pool must not survive it.
        lastCompleted = undefined
        if (picker.value.trim().length > 0) runSearch(picker.value)
      })
      // Closing the picker cancels the walk — rejection is the normal path.
      .catch(() => undefined)

    void this._recentFiles.getAll().then((recent) => {
      if (token.isCancellationRequested) return
      // Show all recent files (in-workspace shown by relative path, others by
      // full fsPath) so this picker fully subsumes "Open Recent File…".
      recentFileItems = recent.map((f) => createFilePick(root, f.uri, f.name))
      // Only seed the list if the user hasn't started typing a query yet.
      if (picker.value.trim().length === 0) picker.items = emptyQueryItems()
    })
  }

  private _provideRecentOnly(
    picker: IQuickPick<IQuickPickItem>,
    options: IQuickAccessProviderRunOptions,
  ): void {
    const { disposables, token } = options
    picker.matchOnDescription = true
    // Keep the provider order (editors → views by MRU → recent files) rather
    // than letting the panel re-sort alphabetically. fuzzyKeepOrder still filters
    // as the user types but skips the score/MRU sort, so view recency survives.
    picker.filterMode = 'fuzzyKeepOrder'
    picker.placeholder = localize('quickInput.openRecentFile.placeholder', 'Open Recent File…')

    const editorPicks = this._buildEditorCandidates(undefined).map((c) => c.pick)
    // Panel-side filtering here (no `filterExternally`), so views are part of the
    // item list rather than appearing only once a query is typed. Harmless with
    // no workspace open: the list is short, and views are then the main thing
    // worth switching to. Editors and views interleave by recency (mirroring the
    // workspace branch), then recent files follow.
    const viewPicks = this._buildViewCandidates().map((c) => c.pick)
    const headPickById = new Map<string, IQuickPickItem>()
    for (const p of [...editorPicks, ...viewPicks]) headPickById.set(p.id, p)

    const interleavedHead = (): IQuickPickItem[] => {
      const seen = new Set<string>()
      const out: IQuickPickItem[] = []
      for (const target of this._recentTargets.getRecentTargets()) {
        const id =
          target.kind === 'editor'
            ? (target.editor.resource?.toString() ??
              encodeEditorPickId(target.group.id, target.editor.id))
            : encodeViewPickId(target.descriptor.id)
        if (seen.has(id)) continue
        const pick = headPickById.get(id)
        if (!pick) continue
        seen.add(id)
        out.push(pick)
      }
      for (const p of headPickById.values()) {
        if (!seen.has(p.id)) out.push(p)
      }
      return out
    }

    disposables.add(
      picker.onDidAccept((items) => {
        const pick = items[0]
        const openToSide = picker.keyMods.ctrl || picker.keyMods.alt
        picker.hide()
        this._acceptPick(pick, { addRecent: false, pinned: false, openToSide })
      }),
    )

    void this._recentFiles.getAll().then((all) => {
      if (token.isCancellationRequested) return
      const headIds = new Set(headPickById.keys())
      const recentPicks = all
        .map((f) => ({
          id: f.uri.toString(),
          label: f.name,
          description: displayPath(f.uri),
          iconId: resourceIconId(f.uri),
        }))
        .filter((it) => !headIds.has(it.id))
      picker.items = [...interleavedHead(), ...recentPicks]
    })
  }
}
