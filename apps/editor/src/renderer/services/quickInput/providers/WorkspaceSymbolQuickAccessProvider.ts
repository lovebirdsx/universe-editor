/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Workspace symbol quick access ('#'): aggregates workspace symbols from the
 *  registered language feature providers (TS/JS, markdown, …) with a debounced,
 *  out-of-order-guarded query. An empty query matches all and is cached for
 *  instant replay on the next open (stale-while-revalidate). Mirrors VSCode's
 *  workbench.action.showAllSymbols.
 *--------------------------------------------------------------------------------------------*/

import {
  IEditorGroupsService,
  IHostService,
  IInstantiationService,
  IWorkspaceService,
  URI,
  isEqualResource,
  localize,
  relativePathUnder,
  toDisposable,
  type HostPlatform,
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

/**
 * Last successful match-all (empty query) result, replayed instantly on the next
 * open so the picker is never blank while the fresh query is in flight
 * (stale-while-revalidate). Keyed by workspace root so one folder never shows
 * another's symbols.
 */
let emptyQueryCache:
  | { readonly rootKey: string; readonly entries: readonly WorkspaceSymbolEntry[] }
  | undefined

function relativePath(root: URI | undefined, uri: URI, platform: HostPlatform): string {
  if (!root) return uri.fsPath
  return relativePathUnder(root.fsPath, uri.fsPath, platform) ?? uri.fsPath
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
  platform: HostPlatform,
): UnifiedWorkspaceSymbol {
  const uri = URI.parse(entry.uri.toString())
  return {
    name: entry.name,
    // workspaceSymbolsToEntries already maps kind to Monaco 0-based.
    iconKind: entry.kind,
    uri,
    lineNumber: entry.range.startLineNumber,
    column: entry.range.startColumn,
    description: relativePath(root, uri, platform),
  }
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
  constructor(
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IInstantiationService private readonly _instantiation: IInstantiationService,
    @ILanguageFeaturesService private readonly _langFeatures: ILanguageFeaturesService,
    @IHostService private readonly _host: IHostService,
  ) {}

  provide(picker: IQuickPick<IQuickPickItem>, options: IQuickAccessProviderRunOptions): void {
    const { disposables, token, prefix } = options
    picker.filterExternally = true
    picker.placeholder = localize(
      'quickInput.showAllSymbols.placeholder',
      'Go to Symbol in Workspace…',
    )

    const root = this._workspace.current?.folder
    const rootKey = root?.toString() ?? ''
    /** Pick id → symbol, so onDidAccept can recover the target location. */
    const byId = new Map<string, UnifiedWorkspaceSymbol>()
    let currentValue = picker.value.slice(prefix.length)
    let seq = 0
    let debounce: ReturnType<typeof setTimeout> | undefined

    const render = (entries: readonly WorkspaceSymbolEntry[], query: string): void => {
      byId.clear()
      const merged = entries.map((e) => tsEntryToUnified(e, root, this._host.platform))
      // An empty (match-all) query has no relevance signal and concatenates
      // multiple providers, so sort by name (then path) for a stable, predictable
      // list — and so the leading MAX_RESULTS slice keeps an alphabetical head
      // instead of an arbitrary, provider-ordered cut. A real query is fuzzy
      // scored against the name and re-sorted by relevance (each server's own
      // ranking mixes poorly across providers), with the matched ranges reused as
      // highlights. Mirrors VSCode's symbols quick access.
      let ranked: { symbol: UnifiedWorkspaceSymbol; matches: readonly IQuickItemHighlight[] }[]
      if (!query) {
        merged.sort(
          (a, b) => a.name.localeCompare(b.name) || a.description.localeCompare(b.description),
        )
        ranked = merged.map((symbol) => ({ symbol, matches: [] }))
      } else {
        ranked = merged
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
      }
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

    // An empty query means "show everything": the language servers' `navto`
    // treats it as match-all, and (like VSCode's symbols quick access) we skip
    // fuzzy scoring for it and render whatever the providers return.
    const refresh = (): void => {
      if (!monacoNs) return
      const ns = monacoNs
      const query = currentValue.trim()
      const mySeq = ++seq
      picker.busy = true
      void Promise.all(
        wsProviders.map((p) =>
          p
            .provideWorkspaceSymbols(query)
            .then((symbols) => workspaceSymbolsToEntries(symbols, ns))
            .catch(() => [] as WorkspaceSymbolEntry[]),
        ),
      ).then((perProvider) => {
        if (token.isCancellationRequested || mySeq !== seq) return
        picker.busy = false
        const flat = perProvider.flat()
        // Seed the next open with this match-all result.
        if (!query) emptyQueryCache = { rootKey, entries: flat }
        render(flat, query)
      })
    }

    const openSymbol = (symbol: UnifiedWorkspaceSymbol): void => {
      const uri = symbol.uri
      let input: FileEditorInput | undefined
      for (const group of this._groups.groups) {
        for (const editor of group.editors) {
          if (editor instanceof FileEditorInput && isEqualResource(editor.resource, uri)) {
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
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(refresh, WORKSPACE_SYMBOL_DEBOUNCE_MS)
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
        seq++
        if (debounce) clearTimeout(debounce)
      }),
    )

    void MonacoLoader.ensureInitialized().then((ns) => {
      if (token.isCancellationRequested) return
      monacoNs = ns
      wsProviders = this._langFeatures.getWorkspaceSymbolProviders()
      // Replay the previous match-all result instantly (stale-while-revalidate)
      // so the picker shows content immediately instead of a blank list.
      if (emptyQueryCache && emptyQueryCache.rootKey === rootKey) {
        render(emptyQueryCache.entries, currentValue.trim())
      }
      // Populate/refresh on open (empty value → match-all). Route it through the
      // same debounce so that if the user starts typing right away, this heavy
      // match-all query is cancelled before it's ever sent — LSP requests are
      // serialized, and an in-flight match-all would stall the real query.
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(refresh, WORKSPACE_SYMBOL_DEBOUNCE_MS)
    })
  }
}
