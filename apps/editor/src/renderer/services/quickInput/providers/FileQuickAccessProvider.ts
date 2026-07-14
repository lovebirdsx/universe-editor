/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Default quick access (no prefix): Go to File. With a workspace open it warms
 *  the full file list once when the picker opens (reusing the @-mention file
 *  cache) and then filters it in-memory on every keystroke — no per-keystroke
 *  disk walk. Recent files show for an empty query; with no workspace it falls
 *  back to the recent files list. Mirrors VSCode's file quick access, whose
 *  cached-listing fast path is what keeps typing responsive on large trees.
 *--------------------------------------------------------------------------------------------*/

import {
  IEditorGroupsService,
  IEditorResolverService,
  IFileSearchService,
  IFileService,
  IUriIdentityService,
  IWorkspaceService,
  URI,
  localize,
  toDisposable,
  type IQuickAccessProvider,
  type IQuickAccessProviderRunOptions,
  type IQuickPick,
  type IQuickPickItem,
} from '@universe-editor/platform'
import { scoreFuzzyMatch } from '@universe-editor/workbench-ui'
import { IRecentFilesService } from '../../recentFiles/recentFilesService.js'
import { IExcludeService } from '../../exclude/ExcludeService.js'
import { loadWorkspaceFiles, type MentionFileEntry } from '../../acp/mentionFileSearch.js'
import { resourceIconId } from '../quickPickResourceIcon.js'

const GO_TO_FILE_MAX_RESULTS = 512

function workspaceRelativePath(root: URI, uri: URI): string {
  const rootPath = root.fsPath.replace(/\\/g, '/').replace(/\/$/, '')
  const norm = uri.fsPath.replace(/\\/g, '/')
  return norm.startsWith(rootPath + '/') ? norm.slice(rootPath.length + 1) : uri.fsPath
}

function createFilePick(root: URI, uri: URI, labelOverride?: string): IQuickPickItem {
  const rel = workspaceRelativePath(root, uri)
  const label = labelOverride ?? rel.split(/[/\\]/).at(-1) ?? uri.fsPath
  return { id: uri.toString(), label, description: rel, iconId: resourceIconId(uri) }
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
  ) {}

  provide(picker: IQuickPick<IQuickPickItem>, options: IQuickAccessProviderRunOptions): void {
    const root = this._workspace.current?.folder
    if (root) this._provideWorkspace(picker, options, root)
    else this._provideRecentOnly(picker, options)
  }

  /** Activate the editor if already open in any group, else open it via the
   *  editor resolver so contributed custom editors (e.g. the PDF viewer) win over
   *  the plain text editor — mirroring how the Explorer opens files. */
  private _open(uri: URI, label: string, opts: { addRecent: boolean; pinned: boolean }): void {
    if (opts.addRecent) this._recentFiles.add(uri, label)
    for (const group of this._groups.groups) {
      for (const editor of group.editors) {
        if (editor.resource && this._uriIdentity.isEqual(editor.resource, uri)) {
          this._groups.activateGroup(group)
          group.setActive(editor)
          return
        }
      }
    }
    void this._editorResolver.openEditor(uri, { pinned: opts.pinned })
  }

  private _provideWorkspace(
    picker: IQuickPick<IQuickPickItem>,
    options: IQuickAccessProviderRunOptions,
    root: URI,
  ): void {
    const { disposables, token } = options
    picker.filterExternally = true
    picker.placeholder = localize('quickInput.goToFile.placeholder', 'Go to File…')

    let recentItems: readonly IQuickPickItem[] = []
    // The cached full file listing (loaded once when the picker opens). Filtering
    // then runs in-memory on every keystroke — no per-keystroke disk walk.
    let allFiles: readonly MentionFileEntry[] | undefined
    let seq = 0

    // In-memory fuzzy filter over the cached listing. Whitespace-separated pieces
    // must all match; a basename hit outranks a path hit; results are capped at 512.
    const filterInMemory = (pattern: string): IQuickPickItem[] => {
      if (allFiles === undefined) return []
      const scored: { entry: MentionFileEntry; score: number }[] = []
      for (const entry of allFiles) {
        const score = scoreFileMatch(entry.name, entry.relPath, pattern)
        if (score >= 0) scored.push({ entry, score })
      }
      scored.sort((a, b) => b.score - a.score || a.entry.relPath.localeCompare(b.entry.relPath))
      return scored.slice(0, GO_TO_FILE_MAX_RESULTS).map((s) => entryToPick(s.entry))
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
      const mySeq = ++seq
      const pattern = value.trim()
      if (pattern.length === 0) {
        picker.busy = false
        picker.items = recentItems
        return
      }
      if (allFiles === undefined) {
        // Listing not warmed yet: keep the spinner; the warm-up below re-runs the
        // current query once files land.
        picker.busy = true
        return
      }
      const items = filterInMemory(pattern)
      picker.items = items
      picker.busy = false
      void prependExactPathMatch(pattern, mySeq, items)
    }

    disposables.add(picker.onDidChangeValue(runSearch))
    disposables.add(
      picker.onDidAccept((items) => {
        const pick = items[0]
        picker.hide()
        if (pick) this._open(URI.parse(pick.id), pick.label, { addRecent: true, pinned: true })
      }),
    )
    disposables.add(toDisposable(() => seq++))

    // Warm the full listing once (cached with a short TTL, shared with @-mention).
    // While it loads, the input stays responsive; the current query re-runs when
    // files arrive so an early keystroke isn't lost.
    if (picker.value.trim().length > 0) picker.busy = true
    void loadWorkspaceFiles(root, this._fileSearch, {
      dirNames: this._exclude.getDirNameIgnores(),
      excludeGlobs: this._exclude.getSearchExcludeGlobs(),
    }).then((files) => {
      if (token.isCancellationRequested) return
      allFiles = files
      if (picker.value.trim().length > 0) runSearch(picker.value)
    })

    void this._recentFiles.getAll().then((recent) => {
      if (token.isCancellationRequested) return
      // Show all recent files (in-workspace shown by relative path, others by
      // full fsPath) so this picker fully subsumes "Open Recent File…".
      recentItems = recent.map((f) => createFilePick(root, f.uri, f.name))
      // Only seed the list if the user hasn't started typing a query yet.
      if (picker.value.trim().length === 0) picker.items = recentItems
    })
  }

  private _provideRecentOnly(
    picker: IQuickPick<IQuickPickItem>,
    options: IQuickAccessProviderRunOptions,
  ): void {
    const { disposables, token } = options
    picker.matchOnDescription = true
    picker.placeholder = localize('quickInput.openRecentFile.placeholder', 'Open Recent File…')

    disposables.add(
      picker.onDidAccept((items) => {
        const pick = items[0]
        picker.hide()
        if (pick) this._open(URI.parse(pick.id), pick.label, { addRecent: false, pinned: false })
      }),
    )

    void this._recentFiles.getAll().then((all) => {
      if (token.isCancellationRequested) return
      picker.items = all.map((f) => ({
        id: f.uri.toString(),
        label: f.name,
        description: f.uri.fsPath,
        iconId: resourceIconId(f.uri),
      }))
    })
  }
}
