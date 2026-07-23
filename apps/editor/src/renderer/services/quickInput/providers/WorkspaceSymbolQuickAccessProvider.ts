/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Workspace symbol quick access ('#'): aggregates workspace symbols from the
 *  registered language feature providers (TS/JS, markdown, …). Mirrors VSCode's
 *  workbench.action.showAllSymbols behavior:
 *    - no live search on an empty query — a match-all query on a large project
 *      returns tens of thousands of symbols and stalls the server's serialized
 *      request queue; instead the empty query shows the previous search's
 *      cached results (VSCode parity: the first open shows nothing, reopening
 *      after a search shows its results);
 *    - the filter pre-fills with the selection / word under the cursor
 *      (defaultFilterValue), so opening with a caret on a symbol searches it;
 *    - keystrokes debounce, and each new query cancels the in-flight one — the
 *      cancellation rides a token all the way into the language server.
 *--------------------------------------------------------------------------------------------*/

import {
  CancellationTokenSource,
  IEditorGroupsService,
  IInstantiationService,
  ILoggerService,
  IUriIdentityService,
  IWorkspaceService,
  URI,
  localize,
  toDisposable,
  type ILogger,
  type IQuickAccessProvider,
  type IQuickAccessProviderRunOptions,
  type IQuickItemHighlight,
  type IQuickPick,
  type IQuickPickItem,
} from '@universe-editor/platform'
import { FileEditorInput } from '../../editor/FileEditorInput.js'
import { openInLockAwareGroup } from '../../editor/openInLockAwareGroup.js'
import { FileEditorRegistry } from '../../editor/FileEditorRegistry.js'
import { ILanguageFeaturesService } from '../../languageFeatures/LanguageFeaturesService.js'
import {
  workspaceSymbolsToEntries,
  type WorkspaceSymbolEntry,
} from '../../languageFeatures/typescript/lspMonacoConvert.js'
import { symbolIconId } from '../../../workbench/symbols/symbolIcon.js'
import { MonacoLoader } from '../../../workbench/editor/monaco/MonacoLoader.js'
import { fuzzyScore } from '@universe-editor/workbench-ui'

type MonacoNamespace = Awaited<ReturnType<typeof MonacoLoader.ensureInitialized>>

const MAX_RESULTS = 512
const WORKSPACE_SYMBOL_DEBOUNCE_MS = 150
/** A longer selection makes a poor symbol filter (VSCode caps at 1024). */
const MAX_FILTER_LENGTH = 1024

function relativePath(root: URI | undefined, uri: URI, uriIdentity: IUriIdentityService): string {
  if (!root) return uri.fsPath
  return uriIdentity.relativePathUnder(root.fsPath, uri.fsPath) ?? uri.fsPath
}

/** A workspace symbol from any language server, normalized for the picker. */
interface UnifiedWorkspaceSymbol {
  readonly name: string
  /** Monaco 0-based SymbolKind, for `symbol-kind-<n>` icon resolution. */
  readonly iconKind: number
  readonly uri: URI
  readonly lineNumber: number
  readonly column: number
  /** Workspace-relative path shown as the item description. */
  readonly description: string
}

function tsEntryToUnified(
  entry: WorkspaceSymbolEntry,
  root: URI | undefined,
  uriIdentity: IUriIdentityService,
): UnifiedWorkspaceSymbol {
  const uri = URI.parse(entry.uri.toString())
  return {
    name: entry.name,
    // workspaceSymbolsToEntries already maps kind to Monaco 0-based.
    iconKind: entry.kind,
    uri,
    lineNumber: entry.range.startLineNumber,
    column: entry.range.startColumn,
    description: relativePath(root, uri, uriIdentity),
  }
}

/**
 * Results of the last settled query, reused for the empty query (VSCode
 * parity). Module-scoped because the controller instantiates the provider
 * per open, and the reuse must span picker sessions.
 */
let lastResults: { root: URI; entries: readonly WorkspaceSymbolEntry[] } | undefined

export function _resetLastResultsForTests(): void {
  lastResults = undefined
}

/** Monaco may not have mounted the editor yet; retry briefly (cf. historyActions). */
async function revealPosition(
  input: FileEditorInput,
  lineNumber: number,
  column: number,
): Promise<void> {
  const apply = (): boolean => {
    const editor = FileEditorRegistry.get(input)
    if (!editor) return false
    editor.setPosition({ lineNumber, column })
    editor.revealLineInCenterIfOutsideViewport(lineNumber)
    editor.focus()
    return true
  }
  if (apply()) return
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  if (apply()) return
  await new Promise<void>((resolve) => setTimeout(resolve, 50))
  apply()
}

export class WorkspaceSymbolQuickAccessProvider implements IQuickAccessProvider {
  private readonly _logger: ILogger

  constructor(
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IInstantiationService private readonly _instantiation: IInstantiationService,
    @ILanguageFeaturesService private readonly _langFeatures: ILanguageFeaturesService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    this._logger = loggerService.createLogger({
      id: 'workspaceSymbolQuickAccess',
      name: 'Workspace Symbol Quick Access',
    })
  }

  /**
   * Prefill the filter with the selection / word under the cursor (VSCode's
   * getSelectionSearchString): opening the picker on a symbol searches it
   * immediately instead of presenting an empty list.
   */
  get defaultFilterValue(): string | undefined {
    const input = this._groups.activeGroup?.activeEditor
    if (!(input instanceof FileEditorInput)) return undefined
    const editor = FileEditorRegistry.get(input)
    const model = editor?.getModel()
    const selection = editor?.getSelection()
    if (!editor || !model || !selection) return undefined
    if (!selection.isEmpty()) {
      if (selection.startLineNumber !== selection.endLineNumber) return undefined
      const text = model.getValueInRange(selection)
      return text.length <= MAX_FILTER_LENGTH ? text : undefined
    }
    return model.getWordAtPosition(selection.getPosition())?.word
  }

  provide(picker: IQuickPick<IQuickPickItem>, options: IQuickAccessProviderRunOptions): void {
    const { disposables, token, prefix } = options
    picker.filterExternally = true
    picker.placeholder = localize(
      'quickInput.showAllSymbols.placeholder',
      'Go to Symbol in Workspace…',
    )

    const root = this._workspace.current?.folder
    /** Pick id → symbol, so onDidAccept can recover the target location. */
    const byId = new Map<string, UnifiedWorkspaceSymbol>()
    let currentValue = picker.value.slice(prefix.length)
    let seq = 0
    let debounce: ReturnType<typeof setTimeout> | undefined
    /** The in-flight query; cancelled by the next keystroke / empty query / hide. */
    let queryCts: CancellationTokenSource | undefined

    const render = (entries: readonly WorkspaceSymbolEntry[], query: string): void => {
      byId.clear()
      const merged = entries.map((e) => tsEntryToUnified(e, root, this._uriIdentity))
      // Fuzzy-score against the name and re-sort by relevance (each server's own
      // ranking mixes poorly across providers), reusing the matched ranges as
      // highlights. Mirrors VSCode's symbols quick access.
      const ranked = merged
        .map((symbol) => {
          const res = fuzzyScore(symbol.name, query)
          return res ? { symbol, score: res.score, matches: res.matches } : undefined
        })
        .filter(
          (
            x,
          ): x is {
            symbol: UnifiedWorkspaceSymbol
            score: number
            matches: readonly IQuickItemHighlight[]
          } => x !== undefined,
        )
        .sort((a, b) => b.score - a.score)
      picker.items = ranked.slice(0, MAX_RESULTS).map((entry, i) => {
        const id = String(i)
        byId.set(id, entry.symbol)
        const languageId = entry.symbol.uri.path.endsWith('.md') ? 'markdown' : undefined
        return {
          id,
          label: entry.symbol.name,
          iconId: symbolIconId(entry.symbol.iconKind, languageId),
          description: entry.symbol.description,
          highlights: { label: entry.matches },
        }
      })
    }

    // Workspace symbols come from whatever providers the language plugins have
    // registered; each activates lazily on opening a file of its language.
    let wsProviders: ReturnType<ILanguageFeaturesService['getWorkspaceSymbolProviders']> = []
    let monacoNs: MonacoNamespace | undefined
    let disposed = false

    const cancelInFlight = (): void => {
      queryCts?.cancel()
      queryCts?.dispose()
      queryCts = undefined
    }

    // No live match-all on an empty query (VSCode parity): show the previous
    // search's cached results for this workspace instead — the first open
    // (nothing cached) renders an empty list.
    const showCachedResults = (): void => {
      seq++
      picker.busy = false
      const cached =
        lastResults && root && this._uriIdentity.isEqual(lastResults.root, root)
          ? lastResults.entries
          : []
      render(cached, '')
    }

    const refresh = (): void => {
      if (disposed || !monacoNs) return
      const ns = monacoNs
      const query = currentValue.trim()
      cancelInFlight()
      if (!query) {
        showCachedResults()
        return
      }
      const mySeq = ++seq
      const startedAt = Date.now()
      picker.busy = true
      const source = (queryCts = new CancellationTokenSource(token))
      void Promise.all(
        wsProviders.map((p) =>
          p
            .provideWorkspaceSymbols(query, source.token)
            .then((symbols) => workspaceSymbolsToEntries(symbols, ns))
            .catch(() => [] as WorkspaceSymbolEntry[]),
        ),
      ).then((perProvider) => {
        const stale = source.token.isCancellationRequested || mySeq !== seq
        // Settled queries no longer need cancellation; disposing here releases
        // the parent-token subscription instead of waiting for the next
        // keystroke / teardown (a short-lived session could otherwise outlive
        // its last query's subscription).
        if (queryCts === source) queryCts = undefined
        source.dispose()
        if (stale || disposed) return
        picker.busy = false
        const flat = perProvider.flat()
        this._logger.debug(
          `workspace symbol query "${query}" → ${flat.length} results in ${Date.now() - startedAt}ms`,
        )
        // Cache the raw results so a later empty query can reuse them.
        if (root) lastResults = { root, entries: flat }
        render(flat, query)
      })
    }

    const scheduleRefresh = (): void => {
      if (disposed) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(refresh, WORKSPACE_SYMBOL_DEBOUNCE_MS)
    }

    const openSymbol = (symbol: UnifiedWorkspaceSymbol): void => {
      const uri = symbol.uri
      let input: FileEditorInput | undefined
      for (const group of this._groups.groups) {
        for (const editor of group.editors) {
          if (
            editor instanceof FileEditorInput &&
            this._uriIdentity.isEqual(editor.resource, uri)
          ) {
            this._groups.activateGroup(group)
            group.setActive(editor)
            input = editor
            break
          }
        }
        if (input) break
      }
      if (!input) {
        input = this._instantiation.createInstance(FileEditorInput, uri)
        openInLockAwareGroup(this._groups, input, { activate: true, pinned: true })
      }
      void revealPosition(input, symbol.lineNumber, symbol.column)
    }

    disposables.add(
      picker.onDidChangeValue((value) => {
        currentValue = value.slice(prefix.length)
        scheduleRefresh()
      }),
    )
    disposables.add(
      picker.onDidAccept((items) => {
        const symbol = items[0] ? byId.get(items[0].id) : undefined
        picker.hide()
        if (symbol) openSymbol(symbol)
      }),
    )
    disposables.add(
      toDisposable(() => {
        disposed = true
        seq++
        cancelInFlight()
        if (debounce) clearTimeout(debounce)
      }),
    )

    void MonacoLoader.ensureInitialized().then((ns) => {
      if (disposed || token.isCancellationRequested) return
      monacoNs = ns
      wsProviders = this._langFeatures.getWorkspaceSymbolProviders()
      // Programmatic value writes don't fire onDidChangeValue, so the '#' prefix
      // prefill (controller-side) never reaches the listener above — re-read the
      // live value now that an initial query can actually run.
      currentValue = picker.value.slice(prefix.length)
      // No match-all on open: a prefilled filter (defaultFilterValue) kicks off
      // an initial query; an empty input reuses the previous search's results.
      if (currentValue.trim()) scheduleRefresh()
      else showCachedResults()
    })
  }
}
