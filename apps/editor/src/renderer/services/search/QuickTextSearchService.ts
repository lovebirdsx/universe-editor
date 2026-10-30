/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Quick Search picker backed by the workspace text search service.
 *--------------------------------------------------------------------------------------------*/

import {
  DisposableStore,
  IEditorGroupsService,
  IInstantiationService,
  IQuickInputService,
  ITextSearchService,
  IUriIdentityService,
  IWorkspaceService,
  InstantiationType,
  URI,
  createDecorator,
  localize,
  registerSingleton,
  type IFileMatch,
  type IQuickItemHighlight,
  type IQuickPickItem,
  type IQuickPickSeparator,
  type ITextSearchMatch,
  type ITextSearchRange,
  type ITextEditorSelection,
  type EditorInput,
  type IEditorGroup,
  type QuickPickInput,
} from '@universe-editor/platform'
import { FileEditorInput } from '../editor/FileEditorInput.js'
import { UntitledEditorInput } from '../editor/UntitledEditorInput.js'
import { getActiveTextEditor } from '../editor/activeTextEditor.js'
import { openInLockAwareGroup } from '../editor/openInLockAwareGroup.js'
import { FileEditorRegistry } from '../editor/FileEditorRegistry.js'
import { revealSelectionInInput } from '../editor/revealEditorPosition.js'
import { canCloneEditorInputForSplit } from '../editor/cloneEditorInput.js'
import { ensureSideGroup } from '../editor/openToSide.js'
import { IWindowFocusService } from '../windows/windowFocusService.js'
import { IAuxiliaryEditorWindowService } from '../windows/auxiliaryEditorWindowService.js'
import { resolveOpenTarget, type OpenTarget } from '../editor/openTarget.js'

export interface IQuickTextSearchService {
  readonly _serviceBrand: undefined
  show(): Promise<void>
}

export const IQuickTextSearchService =
  createDecorator<IQuickTextSearchService>('quickTextSearchService')

const MAX_FILES_SHOWN = 30
const MAX_RESULTS_PER_FILE = 10
const MAX_RESULTS = 500
const DEBOUNCE_DELAY_MS = 75
const SEED_TEXT_MAX_LENGTH = 200
// Coalesce incremental result batches into the picker, the way the search view
// coalesces them into React state. Without streaming, the picker stayed empty
// until ripgrep finished walking the whole tree — for a rare symbol in a huge
// workspace that is far longer than the first hit takes to arrive, because
// MAX_RESULTS is never reached and nothing kills the scan early.
const RESULTS_REFRESH_MS = 100

type QuickTextSearchPickKind = 'match' | 'message'

interface QuickTextSearchPick extends IQuickPickItem {
  readonly kind: QuickTextSearchPickKind
  readonly resource?: URI
  readonly match?: ITextSearchMatch
  readonly rangeIndex?: number
}

type QuickTextSearchInput = QuickPickInput<QuickTextSearchPick>

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

function workspaceRelativePath(root: URI, uri: URI): string {
  // 资源显示走 path 段；file: 用 fsPath 折 Windows 盘符，非 file:（远端）无本机路径。
  const abs = uri.scheme === 'file' ? uri.fsPath : uri.path
  if (root.scheme !== uri.scheme || root.authority !== uri.authority) return abs
  const rootPath = normalizePath(root.path).replace(/\/$/, '')
  const path = normalizePath(uri.path)
  return path.startsWith(rootPath + '/') ? path.slice(rootPath.length + 1) : abs
}

function basename(path: string): string {
  return normalizePath(path).split('/').filter(Boolean).at(-1) ?? path
}

function parentPath(path: string): string {
  const normalized = normalizePath(path)
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? '' : normalized.slice(0, idx)
}

function trimPreview(value: string): string {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : '(blank line)'
}

function makeMessagePick(id: string, label: string): QuickTextSearchPick {
  return { id: `quickTextSearch.message.${id}`, label, kind: 'message' }
}

function makeFileSeparator(resource: URI, rel: string): IQuickPickSeparator {
  const dir = parentPath(rel)
  const base = {
    type: 'separator' as const,
    id: `quickTextSearch.file.${resource.toString()}`,
    label: basename(rel),
  }
  return dir.length > 0 ? { ...base, description: dir } : base
}

function highlightForRange(
  text: string,
  range: ITextSearchRange | undefined,
  leadingTrimmed: number,
): IQuickItemHighlight | undefined {
  if (!range) return undefined
  const start = Math.max(0, range.startColumn - 1 - leadingTrimmed)
  const end = Math.min(text.length, Math.max(start, range.endColumn - 1 - leadingTrimmed))
  return start < end ? { start, end } : undefined
}

function previewForMatch(
  match: ITextSearchMatch,
  rangeIndex: number,
): { readonly label: string; readonly highlights?: QuickTextSearchPick['highlights'] } {
  const leadingTrimmed = match.preview.length - match.preview.trimStart().length
  const label = trimPreview(match.preview)
  const highlight = highlightForRange(label, match.ranges[rangeIndex], leadingTrimmed)
  return highlight ? { label, highlights: { label: [highlight] } } : { label }
}

function selectionForMatch(
  match: ITextSearchMatch,
  rangeIndex: number,
): ITextEditorSelection | undefined {
  const range = match.ranges[rangeIndex]
  if (!range) return undefined
  return {
    startLineNumber: match.lineNumber,
    startColumn: range.startColumn,
    endLineNumber: match.lineNumber,
    endColumn: range.endColumn,
  }
}

function sortFileMatches(
  matches: readonly IFileMatch[],
  activeResource: URI | undefined,
): IFileMatch[] {
  const active = activeResource?.toString()
  return [...matches].sort((a, b) => {
    const aKey = a.resource.toString()
    const bKey = b.resource.toString()
    if (active) {
      if (aKey === active && bKey !== active) return -1
      if (bKey === active && aKey !== active) return 1
    }
    return aKey.localeCompare(bKey)
  })
}

function toPicks(
  root: URI,
  results: readonly IFileMatch[],
  activeResource: URI | undefined,
  limitHit: boolean,
): QuickTextSearchInput[] {
  const picks: QuickTextSearchInput[] = []
  const sorted = sortFileMatches(results, activeResource).slice(0, MAX_FILES_SHOWN)

  for (const fileMatch of sorted) {
    const resource = fileMatch.resource

    const rel = workspaceRelativePath(root, resource)
    const matchPicks: QuickTextSearchPick[] = []

    let shownForFile = 0
    outer: for (const match of fileMatch.matches) {
      for (let rangeIndex = 0; rangeIndex < match.ranges.length; rangeIndex++) {
        const range = match.ranges[rangeIndex]
        if (!range) continue
        if (shownForFile >= MAX_RESULTS_PER_FILE) break outer
        const preview = previewForMatch(match, rangeIndex)
        matchPicks.push({
          id:
            `quickTextSearch.match.${resource.toString()}.` +
            `${match.lineNumber}.${range.startColumn}.${range.endColumn}.${shownForFile}`,
          label: preview.label,
          description: `${match.lineNumber}:${range.startColumn}`,
          ...(preview.highlights ? { highlights: preview.highlights } : {}),
          kind: 'match',
          resource,
          match,
          rangeIndex,
        })
        shownForFile++
      }
    }

    if (matchPicks.length > 0) {
      picks.push(makeFileSeparator(resource, rel), ...matchPicks)
    }
  }

  if (picks.length === 0) {
    return [
      makeMessagePick(
        'emptyResults',
        localize('quickInput.quickSearch.noResults', 'No matching results'),
      ),
    ]
  }

  const hasHiddenFiles = results.length > MAX_FILES_SHOWN
  if (hasHiddenFiles || limitHit) {
    picks.push(
      makeMessagePick(
        'moreResults',
        localize('quickInput.quickSearch.moreResults', 'More results are available in Search.'),
      ),
    )
  }

  return picks
}

function findPickById(
  picks: readonly QuickTextSearchInput[],
  id: string | undefined,
): QuickTextSearchPick | undefined {
  if (id === undefined) return undefined
  for (const pick of picks) {
    if (!('type' in pick) && pick.id === id) return pick
  }
  return undefined
}

export class QuickTextSearchService implements IQuickTextSearchService {
  declare readonly _serviceBrand: undefined

  constructor(
    @IQuickInputService private readonly _quickInput: IQuickInputService,
    @ITextSearchService private readonly _textSearch: ITextSearchService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IInstantiationService private readonly _instantiation: IInstantiationService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
    @IWindowFocusService private readonly _windowFocus: IWindowFocusService,
    @IAuxiliaryEditorWindowService
    private readonly _auxWindows: IAuxiliaryEditorWindowService,
  ) {}

  async show(): Promise<void> {
    const root = this._workspace.current?.folder
    this._quickInput.hide()

    const picker = this._quickInput.createQuickPick<QuickTextSearchPick>()
    picker.placeholder = localize(
      'quickInput.quickSearch.placeholder',
      'Search for text in workspace files.',
    )
    picker.presentation = 'compact'
    picker.filterExternally = true
    picker.items = root
      ? [
          makeMessagePick(
            'enterSearchTerm',
            localize(
              'quickInput.quickSearch.enterTerm',
              'Enter a term to search for across your files.',
            ),
          ),
        ]
      : [
          makeMessagePick(
            'noWorkspace',
            localize('quickInput.quickSearch.noWorkspace', 'Open a folder to search across files.'),
          ),
        ]

    if (!root) {
      await this._showMessageOnlyPicker(picker)
      return
    }

    const seedText = this._getSeedText()
    if (seedText) picker.value = seedText

    await new Promise<void>((resolve) => {
      const store = new DisposableStore()
      let timer: ReturnType<typeof setTimeout> | undefined
      let flushTimer: ReturnType<typeof setTimeout> | undefined
      let requestSeq = 0
      let activeController: AbortController | undefined
      let accepted = false
      let didResolve = false
      // The row the user has navigated to. Re-assigning `picker.items` resets the
      // panel's focus to the first row, so every streamed refresh would yank the
      // highlight away mid-typing; the id lets us put it back.
      let activeId: string | undefined

      const clearFlushTimer = (): void => {
        if (flushTimer !== undefined) {
          clearTimeout(flushTimer)
          flushTimer = undefined
        }
      }

      const cleanup = (): void => {
        requestSeq++
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        clearFlushTimer()
        activeController?.abort()
        activeController = undefined
        store.dispose()
        picker.dispose()
      }

      const resolveOnce = (): void => {
        if (didResolve) return
        didResolve = true
        cleanup()
        resolve()
      }

      const openPick = async (pick: QuickTextSearchPick, target: OpenTarget): Promise<void> => {
        if (pick.kind === 'message' || !pick.resource) return
        if (target === 'side') {
          this._revealOrFocus(this._openFileToSide(pick.resource), pick)
          return
        }
        if (target === 'newWindow') {
          const opened = await this._openFileInNewWindow(pick.resource)
          if (opened) {
            this._revealOrFocus(opened, pick)
            return
          }
          // Fall through to the default in-window path when the window failed.
        }
        this._revealOrFocus(this._openFile(pick.resource, false), pick)
      }

      const runSearch = async (value: string): Promise<void> => {
        const pattern = value.trim()
        const seq = ++requestSeq
        activeController?.abort()
        activeController = undefined
        clearFlushTimer()

        if (pattern.length === 0) {
          picker.busy = false
          picker.items = [
            makeMessagePick(
              'enterSearchTerm',
              localize(
                'quickInput.quickSearch.enterTerm',
                'Enter a term to search for across your files.',
              ),
            ),
          ]
          return
        }

        const controller = new AbortController()
        activeController = controller
        let limitHit = false
        // Incremental batches accumulate here (append-only, keyed by resource) and
        // are coalesced into the picker on a timer, so hits show up while ripgrep
        // is still walking the tree instead of only once it exits.
        const accum = new Map<string, IFileMatch>()

        // Drop whatever the previous query left on screen: stale rows would read
        // as results for the new pattern. The "no results" message is deliberately
        // not shown here — an empty accumulator mid-scan means "not yet", and only
        // the settled promise can say there is genuinely nothing.
        picker.items = []
        picker.busy = true

        const render = (results: readonly IFileMatch[]): void => {
          const keepId = activeId
          const picks = toPicks(root, results, this._getActiveFileResource(), limitHit)
          picker.items = picks
          // Runs after the panel's focus-reset effect, so this wins for the commit
          // in which both fire. When the row is gone (or the previous highlight was
          // the placeholder message) we leave activeItems alone and let the panel
          // fall back to focusing the first row.
          const keep = findPickById(picks, keepId)
          if (keep) picker.activeItems = [keep]
        }

        const flush = (): void => {
          flushTimer = undefined
          if (seq !== requestSeq) return
          render([...accum.values()])
        }

        try {
          const results = await this._textSearch.search(
            {
              pattern,
              isRegex: false,
              matchCase: false,
              matchWholeWord: false,
              includes: [],
              excludes: [],
              maxResults: MAX_RESULTS,
              maxMatchesPerFile: MAX_RESULTS_PER_FILE,
            },
            {
              signal: controller.signal,
              onProgress: (progress) => {
                if (progress.limitHit !== undefined) limitHit = true
              },
              onResults: (batch) => {
                // In-flight batches from a query the user has already moved past
                // must not paint over the current one.
                if (seq !== requestSeq) return
                for (const fileMatch of batch) {
                  accum.set(fileMatch.resource.toString(), fileMatch)
                }
                if (flushTimer === undefined) flushTimer = setTimeout(flush, RESULTS_REFRESH_MS)
              },
            },
          )
          if (seq !== requestSeq) return
          clearFlushTimer()
          // The settled result is authoritative: unlike the accumulated batches
          // it is deduplicated, with in-memory buffer hits overriding the stale
          // on-disk snapshot of the same file.
          render(results)
        } catch {
          if (seq !== requestSeq) return
          clearFlushTimer()
          picker.items = [
            makeMessagePick(
              'searchFailed',
              localize('quickInput.quickSearch.failed', 'Search failed.'),
            ),
          ]
        } finally {
          if (seq === requestSeq) {
            picker.busy = false
            if (activeController === controller) activeController = undefined
          }
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
        }, DEBOUNCE_DELAY_MS)
      }

      store.add(picker.onDidChangeValue(scheduleSearch))
      store.add(
        picker.onDidChangeActive((item) => {
          activeId = item?.id
        }),
      )
      store.add(
        picker.onDidAccept((items) => {
          const pick = items[0]
          if (!pick || pick.kind === 'message') return
          accepted = true
          void openPick(pick, resolveOpenTarget(picker.keyMods)).finally(resolveOnce)
        }),
      )
      store.add(
        picker.onDidHide(() => {
          if (!accepted) resolveOnce()
        }),
      )

      picker.show()
      scheduleSearch(seedText)
    })
  }

  private async _showMessageOnlyPicker(picker: ReturnType<IQuickInputService['createQuickPick']>) {
    await new Promise<void>((resolve) => {
      const store = new DisposableStore()
      let didResolve = false
      const resolveOnce = (): void => {
        if (didResolve) return
        didResolve = true
        store.dispose()
        picker.dispose()
        resolve()
      }
      store.add(picker.onDidAccept(() => resolveOnce()))
      store.add(picker.onDidHide(() => resolveOnce()))
      picker.show()
    })
  }

  private _getActiveFileResource(): URI | undefined {
    const active = this._groups.activeGroup.activeEditor
    return active instanceof FileEditorInput || active instanceof UntitledEditorInput
      ? active.resource
      : undefined
  }

  private _getSeedText(): string {
    const active = getActiveTextEditor(this._groups)
    if (!active) return ''
    const { editor } = active
    const selection = editor.getSelection()
    if (!selection || selection.isEmpty()) return ''
    const text = editor.getModel()?.getValueInRange(selection).trim()
    if (!text || text.includes('\n')) return ''
    return text.length > SEED_TEXT_MAX_LENGTH ? text.slice(0, SEED_TEXT_MAX_LENGTH) : text
  }

  private _revealOrFocus(input: EditorInput, pick: QuickTextSearchPick): void {
    const selection =
      pick.kind === 'match' && pick.match && pick.rangeIndex !== undefined
        ? selectionForMatch(pick.match, pick.rangeIndex)
        : undefined
    if (selection) {
      // A cold file's Monaco editor mounts only after its model resolves — disk
      // read + model creation + React render can take seconds. Hand the reveal
      // to the event-driven helper and return so the picker closes now, not when
      // the mount happens (same contract as the new-window path).
      void revealSelectionInInput(input, selection)
    } else {
      this._focusEditor(input)
    }
  }

  /** Open the picked file in the side group, reusing a tab already there.
   *  Does not dedupe against other groups — Ctrl+Enter asks for a second view. */
  private _openFileToSide(resource: URI): EditorInput {
    const side = ensureSideGroup(this._groups)
    for (const editor of side.editors) {
      if (
        (editor instanceof FileEditorInput || editor instanceof UntitledEditorInput) &&
        this._uriIdentity.isEqual(editor.resource, resource)
      ) {
        side.setActive(editor)
        this._windowFocus.focusGroup(side)
        return editor
      }
    }
    const input = this._instantiation.createInstance(FileEditorInput, resource)
    openInLockAwareGroup(this._groups, input, { activate: true, pinned: false }, side)
    this._windowFocus.focusGroup(side)
    return input
  }

  /** Open the picked file in an auxiliary editor window. Reuses the open tab's
   *  input as a copy when it can be cloned; otherwise opens a fresh input.
   *  Returns undefined when the window could not open the editor. */
  private async _openFileInNewWindow(resource: URI): Promise<EditorInput | undefined> {
    const existing = this._findOpenFile(resource)
    if (existing) {
      try {
        const result = await this._auxWindows.openEditorInNewWindow(existing.editor, {
          mode: canCloneEditorInputForSplit(existing.editor) ? 'copy' : 'move',
          source: existing.group,
          preferOtherDisplayMaximized: true,
        })
        if (result.ok) return result.editor
      } catch {
        // fall through to undefined → caller opens in the active group
      }
      return undefined
    }
    const input = this._instantiation.createInstance(FileEditorInput, resource)
    try {
      const result = await this._auxWindows.openEditorInNewWindow(input, {
        mode: 'open',
        pinned: false,
        preferOtherDisplayMaximized: true,
      })
      if (result.ok) return result.editor
    } catch {
      // fall through to cleanup + fallback
    }
    if (!input.isDisposed) input.dispose()
    return undefined
  }

  private _findOpenFile(resource: URI): { group: IEditorGroup; editor: EditorInput } | undefined {
    for (const group of this._groups.groups) {
      for (const editor of group.editors) {
        if (
          (editor instanceof FileEditorInput || editor instanceof UntitledEditorInput) &&
          this._uriIdentity.isEqual(editor.resource, resource)
        ) {
          return { group, editor }
        }
      }
    }
    return undefined
  }

  private _openFile(resource: URI, pinned: boolean): EditorInput {
    const existing = this._findOpenFile(resource)
    if (existing) {
      this._groups.activateGroup(existing.group)
      existing.group.setActive(existing.editor)
      this._windowFocus.focusGroup(existing.group)
      if (pinned) existing.group.pinEditor(existing.editor)
      return existing.editor
    }

    const input = this._instantiation.createInstance(FileEditorInput, resource)
    openInLockAwareGroup(this._groups, input, { activate: true, pinned })
    return input
  }

  private _focusEditor(input: EditorInput): void {
    FileEditorRegistry.get(input)?.focus()
  }
}

registerSingleton(IQuickTextSearchService, QuickTextSearchService, InstantiationType.Delayed)
