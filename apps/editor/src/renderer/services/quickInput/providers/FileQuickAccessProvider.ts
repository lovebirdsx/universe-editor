/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Default quick access (no prefix): Go to File. With a workspace open it runs a
 *  debounced external file search (recent files shown for an empty query); with
 *  no workspace it falls back to the recent files list. Mirrors VSCode's file
 *  quick access (workbench.action.quickOpen).
 *--------------------------------------------------------------------------------------------*/

import {
  IEditorGroupsService,
  IEditorResolverService,
  IFileSearchService,
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
import { IRecentFilesService } from '../../recentFiles/recentFilesService.js'
import { IExcludeService } from '../../exclude/ExcludeService.js'
import { resourceIconId } from '../quickPickResourceIcon.js'

const GO_TO_FILE_MAX_RESULTS = 512
const GO_TO_FILE_SEARCH_DELAY_MS = 200

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

export class FileQuickAccessProvider implements IQuickAccessProvider {
  constructor(
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IFileSearchService private readonly _fileSearch: IFileSearchService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IRecentFilesService private readonly _recentFiles: IRecentFilesService,
    @IExcludeService private readonly _exclude: IExcludeService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
    @IEditorResolverService private readonly _editorResolver: IEditorResolverService,
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
    let timer: ReturnType<typeof setTimeout> | undefined
    let seq = 0

    const runSearch = async (value: string): Promise<void> => {
      const mySeq = ++seq
      const pattern = value.trim()
      if (pattern.length === 0) {
        picker.busy = false
        picker.items = recentItems
        return
      }
      picker.busy = true
      try {
        const complete = await this._fileSearch.search({
          root,
          pattern,
          excludes: this._exclude.getSearchExcludeGlobs(),
          ignore: this._exclude.getDirNameIgnores(),
          maxResults: GO_TO_FILE_MAX_RESULTS,
          includeExactPathMatches: true,
        })
        if (mySeq !== seq || token.isCancellationRequested) return
        picker.items = complete.results.map((match) => {
          const resource = URI.revive(match.resource)!
          return {
            id: resource.toString(),
            label: match.basename,
            description: match.relativePath,
            iconId: resourceIconId(resource),
          }
        })
      } finally {
        if (mySeq === seq) picker.busy = false
      }
    }

    const scheduleSearch = (value: string): void => {
      if (timer !== undefined) clearTimeout(timer)
      if (value.trim().length === 0) {
        void runSearch(value)
        return
      }
      timer = setTimeout(() => {
        timer = undefined
        void runSearch(value)
      }, GO_TO_FILE_SEARCH_DELAY_MS)
    }

    disposables.add(picker.onDidChangeValue(scheduleSearch))
    disposables.add(
      picker.onDidAccept((items) => {
        const pick = items[0]
        picker.hide()
        if (pick) this._open(URI.parse(pick.id), pick.label, { addRecent: true, pinned: true })
      }),
    )
    disposables.add(
      toDisposable(() => {
        seq++
        if (timer !== undefined) clearTimeout(timer)
      }),
    )

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
