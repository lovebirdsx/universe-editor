/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Default quick access (no prefix): Go to File. With a workspace open it warms
 *  the full file list once when the picker opens (reusing the @-mention file
 *  cache) and then filters it in-memory on every keystroke — no per-keystroke
 *  disk walk. Large listings score in time-sliced chunks off the input event,
 *  and every completed scan narrows the candidate pool for the next extending
 *  keystroke (fuzzy matches are subsequence-based, so extending the query can
 *  only shrink the match set) — huge workspaces stay responsive too.
 *  Open editors (all types, MRU order) head the empty-query list and
 *  join fuzzy matching while typing, followed by recent files; with no workspace
 *  it falls back to the recent files list. Mirrors VSCode's file quick access,
 *  whose cached-listing fast path is what keeps typing responsive on large trees.
 *--------------------------------------------------------------------------------------------*/

import {
  EditorRegistry,
  GroupDirection,
  IEditorGroupsService,
  IEditorResolverService,
  IFileSearchService,
  IFileService,
  IInstantiationService,
  IUriIdentityService,
  IWorkspaceService,
  URI,
  localize,
  toDisposable,
  type IQuickAccessProvider,
  type IQuickAccessProviderRunOptions,
  type IQuickPick,
  type IQuickPickItem,
  type IEditorGroup,
} from '@universe-editor/platform'
import { compareByScoreThenPath, scoreFuzzyMatch } from '@universe-editor/workbench-ui'
import { recordPerfPhase, recordPerfPhaseAsync } from '../../performance/perfPhases.js'
import { IRecentFilesService } from '../../recentFiles/recentFilesService.js'
import { IExcludeService } from '../../exclude/ExcludeService.js'
import {
  loadWorkspaceFiles,
  peekWorkspaceFiles,
  type MentionFileEntry,
  type MentionFileFilter,
} from '../../acp/mentionFileSearch.js'
import {
  decodeEditorPickId,
  encodeEditorPickId,
  IRecentEditorsService,
} from '../../editor/RecentEditorsService.js'
import { IClosedEditorsService } from '../../editor/ClosedEditorsService.js'
import { resourceIconId } from '../quickPickResourceIcon.js'

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
}

function workspaceRelativePath(root: URI, uri: URI): string {
  const rootPath = root.fsPath.replace(/\\/g, '/').replace(/\/$/, '')
  const norm = uri.fsPath.replace(/\\/g, '/')
  return norm.startsWith(rootPath + '/') ? norm.slice(rootPath.length + 1) : uri.fsPath
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
  const label = labelOverride ?? rel.split(/[/\\]/).at(-1) ?? uri.fsPath
  return { id: uri.toString(), label, description: rel, iconId: resourceIconId(uri) }
}

/** An open editor as a pick candidate: the pick itself plus the strings the
 *  fuzzy scorer matches against (label + path, mirroring file entries). */
interface EditorPickCandidate {
  readonly pick: IQuickPickItem
  readonly name: string
  readonly path: string
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
  constructor(
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IFileSearchService private readonly _fileSearch: IFileSearchService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IRecentFilesService private readonly _recentFiles: IRecentFilesService,
    @IExcludeService private readonly _exclude: IExcludeService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
    @IEditorResolverService private readonly _editorResolver: IEditorResolverService,
    @IFileService private readonly _fileService: IFileService,
    @IRecentEditorsService private readonly _recentEditors: IRecentEditorsService,
    @IClosedEditorsService private readonly _closedEditors: IClosedEditorsService,
    @IInstantiationService private readonly _inst: IInstantiationService,
  ) {}

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
    for (const { editor, group } of this._recentEditors.getRecentEditors()) {
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
      if (uri.scheme !== 'file') return
      void this._editorResolver.openEditor(uri, { pinned: true })
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
    if (uri.scheme !== 'file') return
    void this._editorResolver.openEditor(uri, { pinned: opts.pinned })
  }

  /** Restore a just-closed editor with its exact typeId via the closed-editors
   *  stack (same deserialize path as Reopen Closed Editor) instead of
   *  re-guessing the type through the resolver — the resolver can pick the
   *  wrong type for equal-priority custom editors and cannot handle virtual
   *  resources (markdown-preview:…) at all. Returns false when nothing
   *  restorable matches, or when deserialize fails (the consumed entry is then
   *  dropped, mirroring ReopenClosedEditorAction). */
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
    const group = targetGroup ?? this._groups.getGroup(closed.groupId) ?? this._groups.activeGroup
    this._groups.activateGroup(group)
    group.openEditor(input, { activate: true, pinned })
    return true
  }

  private _acceptPick(
    pick: IQuickPickItem | undefined,
    opts: { addRecent: boolean; pinned: boolean; openToSide: boolean },
  ): void {
    if (!pick) return
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

    // Open editors (all types, MRU order) participate both as the head of the
    // empty-query list and as fuzzy-match candidates while typing — mirroring
    // VSCode, where Ctrl+P mixes open editors with recent files.
    const editorCandidates = this._buildEditorCandidates(root)
    const editorPicks = editorCandidates.map((c) => c.pick)

    let recentFileItems: readonly IQuickPickItem[] = []
    const emptyQueryItems = (): IQuickPickItem[] => {
      const editorIds = new Set(editorPicks.map((p) => p.id))
      return [...editorPicks, ...recentFileItems.filter((it) => !editorIds.has(it.id))].slice(
        0,
        GO_TO_FILE_MAX_RESULTS,
      )
    }
    // The cached full file listing (loaded once when the picker opens). Filtering
    // then runs in-memory on every keystroke — no per-keystroke disk walk.
    let allFiles: readonly MentionFileEntry[] | undefined
    let seq = 0
    // The last fully-scanned pattern and the entries it matched. A keystroke
    // that extends that pattern only rescans this (usually far smaller) match
    // set — subsequence matching guarantees extending the query can only shrink
    // it. Reset whenever a fresh listing lands.
    let lastCompleted: { pattern: string; entries: readonly MentionFileEntry[] } | undefined

    // Fuzzy match over the open-editor candidates only — used both as the
    // editor tier of the full filter and as the cold-cache fallback list.
    const matchEditors = (
      pattern: string,
    ): { pick: IQuickPickItem; score: number; path: string }[] => {
      const hits: { pick: IQuickPickItem; score: number; path: string }[] = []
      for (const cand of editorCandidates) {
        const score = scoreFileMatch(cand.name, cand.path, pattern)
        if (score >= 0) hits.push({ pick: cand.pick, score, path: cand.path })
      }
      return hits
    }

    // In-memory fuzzy filter over the candidate pool. Whitespace-separated pieces
    // must all match; a basename hit outranks a path hit; results are capped at 512.
    // Small pools filter synchronously inside the keystroke (zero added latency);
    // large pools scan in time-sliced chunks so the input event returns instantly.
    const sortRows = (rows: ScoredRow[]): void => {
      rows.sort((a, b) => compareByScoreThenPath(a.score, b.score, a.path, b.path))
    }
    const finalizeRows = (rows: ScoredRow[]): IQuickPickItem[] => {
      sortRows(rows)
      return rows.slice(0, GO_TO_FILE_MAX_RESULTS).map((r) => r.pick ?? entryToPick(r.entry!))
    }
    const editorRows = (pattern: string): { rows: ScoredRow[]; ids: Set<string> } => {
      const hits = matchEditors(pattern)
      return {
        rows: hits.map((h) => ({ score: h.score, path: h.path, pick: h.pick })),
        ids: new Set(hits.map((h) => h.pick.id)),
      }
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

    const filterPoolSync = (
      pattern: string,
      pool: readonly MentionFileEntry[],
    ): IQuickPickItem[] => {
      const { rows, ids } = editorRows(pattern)
      const matched: MentionFileEntry[] = []
      scanPool(pool, 0, pattern, ids, rows, matched)
      lastCompleted = { pattern, entries: matched }
      return finalizeRows(rows)
    }

    // Chunked scan for large pools: abandons itself (returns undefined) when a
    // newer keystroke bumps `seq` or the picker is dismissed.
    const filterPoolChunked = async (
      pattern: string,
      pool: readonly MentionFileEntry[],
      mySeq: number,
    ): Promise<IQuickPickItem[] | undefined> => {
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
      return finalizeRows(rows)
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
      const target = URI.file(
        pattern.replace(/\\/g, '/').startsWith('/') || /^[a-zA-Z]:/.test(pattern)
          ? pattern
          : `${root.fsPath.replace(/\\/g, '/').replace(/\/$/, '')}/${pattern}`,
      )
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
          .sort((a, b) => compareByScoreThenPath(a.score, b.score, a.path, b.path))
          .slice(0, GO_TO_FILE_MAX_RESULTS)
          .map((h) => h.pick)
        picker.items = editorOnly
        void prependExactPathMatch(pattern, mySeq, editorOnly)
        return
      }
      const pool = candidatePool(pattern)
      if (pool.length <= SYNC_FILTER_LIMIT) {
        const items = recordPerfPhase('quickOpen.filterFiles', () => filterPoolSync(pattern, pool))
        picker.items = items
        picker.busy = false
        void prependExactPathMatch(pattern, mySeq, items)
        return
      }
      picker.busy = true
      void recordPerfPhaseAsync('quickOpen.filterFiles', () =>
        filterPoolChunked(pattern, pool, mySeq),
      ).then((items) => {
        if (!items || mySeq !== seq || token.isCancellationRequested) return
        picker.items = items
        picker.busy = false
        void prependExactPathMatch(pattern, mySeq, items)
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
    const filter: MentionFileFilter = {
      dirNames: this._exclude.getDirNameIgnores(),
      excludeGlobs: this._exclude.getSearchExcludeGlobs(),
    }
    allFiles = peekWorkspaceFiles(root, filter)
    if (picker.value.trim().length > 0) {
      if (allFiles === undefined) picker.busy = true
      else runSearch(picker.value)
    }
    void loadWorkspaceFiles(root, this._fileSearch, filter, token)
      .then((files) => {
        if (token.isCancellationRequested) return
        allFiles = files
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
    picker.placeholder = localize('quickInput.openRecentFile.placeholder', 'Open Recent File…')

    const editorPicks = this._buildEditorCandidates(undefined).map((c) => c.pick)

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
      const editorIds = new Set(editorPicks.map((p) => p.id))
      picker.items = [
        ...editorPicks,
        ...all
          .map((f) => ({
            id: f.uri.toString(),
            label: f.name,
            description: f.uri.fsPath,
            iconId: resourceIconId(f.uri),
          }))
          .filter((it) => !editorIds.has(it.id)),
      ]
    })
  }
}
