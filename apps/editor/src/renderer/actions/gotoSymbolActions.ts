/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Symbol navigation pickers backed by our own quick pick:
 *    - Go to Symbol in Workspace (Ctrl+T) — aggregates workspace symbols from the
 *      markdown and TS/JS language servers. Mirrors VSCode's
 *      `workbench.action.showAllSymbols`.
 *    - Go to Symbol in Editor (Ctrl+Shift+O) — the active editor's document
 *      symbols from IOutlineService, with live preview. Mirrors VSCode's
 *      `workbench.action.gotoSymbol` (replaces monaco's quickOutline).
 *  Pickers debounce input and guard against out-of-order responses with a
 *  request sequence (cf. GoToFileAction).
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  DisposableStore,
  IEditorGroupsService,
  IHostService,
  IInstantiationService,
  IQuickInputService,
  IWorkspaceService,
  URI,
  autorun,
  localize,
  relativePathUnder,
  type HostPlatform,
  type IQuickItemHighlight,
  type IQuickPickItem,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { scoreFuzzyMatch } from '@universe-editor/workbench-ui'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'
import { IOutlineService } from '../services/languageFeatures/OutlineService.js'
import { flattenOutline } from '../services/languageFeatures/outlineFlatten.js'
import { type monaco, MonacoLoader } from '../workbench/editor/monaco/MonacoLoader.js'
import {
  IMarkdownLanguageService,
  type MdWorkspaceSymbol,
} from '../../shared/ipc/markdownLanguageService.js'
import { ITypescriptLanguageService } from '../../shared/ipc/typescriptLanguageService.js'
import {
  workspaceSymbolsToEntries,
  type WorkspaceSymbolEntry,
} from '../services/languageFeatures/typescript/lspMonacoConvert.js'

const MAX_RESULTS = 512
const WORKSPACE_SYMBOL_DEBOUNCE_MS = 150

function relativePath(root: URI | undefined, uri: URI, platform: HostPlatform): string {
  if (!root) return uri.fsPath
  return relativePathUnder(root.fsPath, uri.fsPath, platform) ?? uri.fsPath
}

/**
 * Match positions for `query` in `text`, aligned with scoreFuzzyMatch's tiers:
 * a contiguous substring highlights as one span, otherwise fall back to a
 * per-character subsequence. Returns `[]` when the query is empty or absent.
 */
function fuzzyHighlights(text: string, query: string): readonly IQuickItemHighlight[] {
  if (!query) return []
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  const idx = t.indexOf(q)
  if (idx >= 0) return [{ start: idx, end: idx + q.length }]
  const out: IQuickItemHighlight[] = []
  let qi = 0
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      out.push({ start: i, end: i + 1 })
      qi++
    }
  }
  return qi === q.length ? out : []
}

/**
 * VSCode-style ranking over a cached symbol set: an empty query keeps the
 * original order (so the picker shows everything on open), otherwise symbols
 * are scored by name and sorted by relevance. Only the symbol name is matched.
 */
function rankSymbols(
  allSymbols: readonly MdWorkspaceSymbol[],
  query: string,
): readonly MdWorkspaceSymbol[] {
  if (!query) return allSymbols.slice(0, MAX_RESULTS)
  return allSymbols
    .map((symbol) => ({ symbol, score: scoreFuzzyMatch(symbol.name, query) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS)
    .map((entry) => entry.symbol)
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

function mdSymbolToUnified(
  symbol: MdWorkspaceSymbol,
  root: URI | undefined,
  platform: HostPlatform,
): UnifiedWorkspaceSymbol {
  const uri = URI.parse(symbol.location.uri)
  return {
    name: symbol.name,
    // MdWorkspaceSymbol.kind is LSP 1-based; the icon resolver expects Monaco 0-based.
    iconKind: symbol.kind - 1,
    uri,
    lineNumber: symbol.location.range.start.line + 1,
    column: symbol.location.range.start.character + 1,
    description: relativePath(root, uri, platform),
  }
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

export class GoToWorkspaceSymbolAction extends Action2 {
  static readonly ID = 'workbench.action.showAllSymbols'
  constructor() {
    super({
      id: GoToWorkspaceSymbolAction.ID,
      title: localize('action.showAllSymbols.title', 'Go to Symbol in Workspace…'),
      category: localize('command.category.go', 'Go'),
      keybinding: { primary: 'ctrl+t' },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const quickInput = accessor.get(IQuickInputService)
    const workspace = accessor.get(IWorkspaceService)
    const groups = accessor.get(IEditorGroupsService)
    const inst = accessor.get(IInstantiationService)
    const md = accessor.get(IMarkdownLanguageService)
    const ts = accessor.get(ITypescriptLanguageService)
    const host = accessor.get(IHostService)

    const root = workspace.current?.folder
    const monacoNs = await MonacoLoader.ensureInitialized()
    await Promise.all([md.ensureStarted(root?.fsPath), ts.ensureStarted(root?.fsPath)])

    const picker = quickInput.createQuickPick<IQuickPickItem>()
    picker.placeholder = localize(
      'quickInput.showAllSymbols.placeholder',
      'Go to Symbol in Workspace…',
    )
    picker.filterExternally = true

    /** Pick id → symbol, so onDidAccept can recover the target location. */
    const byId = new Map<string, UnifiedWorkspaceSymbol>()
    /** Markdown symbols fetched once on open; filtered locally per keystroke. */
    let allMarkdown: readonly MdWorkspaceSymbol[] = []

    await new Promise<void>((resolve) => {
      const store = new DisposableStore()
      let accepted = false
      let didResolve = false
      let currentValue = ''
      let seq = 0
      let debounce: ReturnType<typeof setTimeout> | undefined

      const resolveOnce = (): void => {
        if (didResolve) return
        didResolve = true
        if (debounce) clearTimeout(debounce)
        store.dispose()
        picker.dispose()
        resolve()
      }

      const render = (
        mdSymbols: readonly MdWorkspaceSymbol[],
        tsEntries: readonly WorkspaceSymbolEntry[],
        query: string,
      ): void => {
        byId.clear()
        const merged: UnifiedWorkspaceSymbol[] = [
          ...mdSymbols.map((s) => mdSymbolToUnified(s, root, host.platform)),
          ...tsEntries.map((e) => tsEntryToUnified(e, root, host.platform)),
        ]
        picker.items = merged.slice(0, MAX_RESULTS).map((symbol, i) => {
          const id = String(i)
          byId.set(id, symbol)
          return {
            id,
            label: symbol.name,
            iconId: `symbol-kind-${symbol.iconKind}`,
            description: symbol.description,
            highlights: { label: fuzzyHighlights(symbol.name, query) },
          }
        })
      }

      // tsserver's `workspace/symbol` filters server-side and returns nothing for
      // an empty query, so we only hit it once there's a query; markdown is
      // cached and filtered locally so it can show everything on open.
      const refresh = (): void => {
        const query = currentValue.trim()
        const mdSymbols = rankSymbols(allMarkdown, query)
        if (!query) {
          render(mdSymbols, [], query)
          return
        }
        const mySeq = ++seq
        picker.busy = true
        void ts
          .provideWorkspaceSymbols(query)
          .then((symbols) => {
            if (didResolve || mySeq !== seq) return
            picker.busy = false
            render(mdSymbols, workspaceSymbolsToEntries(symbols, monacoNs), query)
          })
          .catch(() => {
            if (didResolve || mySeq !== seq) return
            picker.busy = false
          })
        // Show markdown immediately while the TS query is in flight.
        render(mdSymbols, [], query)
      }

      const openSymbol = (symbol: UnifiedWorkspaceSymbol): void => {
        const uri = symbol.uri
        let input: FileEditorInput | undefined
        for (const group of groups.groups) {
          for (const editor of group.editors) {
            if (
              editor instanceof FileEditorInput &&
              editor.resource.toString() === uri.toString()
            ) {
              groups.activateGroup(group)
              group.setActive(editor)
              input = editor
              break
            }
          }
          if (input) break
        }
        if (!input) {
          input = inst.createInstance(FileEditorInput, uri)
          groups.activeGroup.openEditor(input, { activate: true, pinned: true })
        }
        void revealPosition(input, symbol.lineNumber, symbol.column)
      }

      store.add(
        picker.onDidChangeValue((value) => {
          currentValue = value
          if (debounce) clearTimeout(debounce)
          debounce = setTimeout(refresh, WORKSPACE_SYMBOL_DEBOUNCE_MS)
        }),
      )
      store.add(
        picker.onDidAccept((items) => {
          const pick = items[0]
          if (!pick) return
          const symbol = byId.get(pick.id)
          accepted = true
          if (symbol) openSymbol(symbol)
          resolveOnce()
        }),
      )
      store.add(
        picker.onDidHide(() => {
          if (!accepted) resolveOnce()
        }),
      )

      picker.busy = true
      picker.show()
      void md.provideWorkspaceSymbols('').then((symbols) => {
        if (didResolve) return
        allMarkdown = symbols
        picker.busy = false
        refresh()
      })
    })
  }
}

/**
 * Go to Symbol in Editor (Ctrl+Shift+O) — lists the active editor's document
 * symbols (from IOutlineService) in our own quick pick, replacing monaco's
 * built-in quickOutline. Nesting is shown via indentation; moving through the
 * list live-previews the symbol (scroll + highlight, no focus/cursor change),
 * and cancelling restores the original view. Mirrors VSCode's
 * `workbench.action.gotoSymbol`.
 */
export class GoToFileSymbolAction extends Action2 {
  static readonly ID = 'workbench.action.gotoSymbol'
  constructor() {
    super({
      id: GoToFileSymbolAction.ID,
      title: localize('action.gotoSymbol.title', 'Go to Symbol in Editor…'),
      category: localize('command.category.go', 'Go'),
      keybinding: { primary: 'ctrl+shift+o' },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const quickInput = accessor.get(IQuickInputService)
    const outline = accessor.get(IOutlineService)

    const picker = quickInput.createQuickPick<IQuickPickItem>()
    picker.placeholder = localize('quickInput.gotoSymbol.placeholder', 'Go to Symbol in Editor…')

    /** Pick id → symbol, so accept/preview can recover the target. */
    const byId = new Map<string, monaco.languages.DocumentSymbol>()
    const initial = outline.captureViewState()

    await new Promise<void>((resolve) => {
      const store = new DisposableStore()
      let accepted = false
      let didResolve = false
      const resolveOnce = (): void => {
        if (didResolve) return
        didResolve = true
        store.dispose()
        picker.dispose()
        resolve()
      }

      // Keep the list in sync with the outline (handles symbols that arrive
      // after the picker opens, e.g. just-opened file). The editor isn't being
      // edited while the picker has focus, so this effectively runs once.
      store.add(
        autorun((r) => {
          const model = outline.outline.read(r)
          const flat = model ? flattenOutline(model.roots) : []
          byId.clear()
          picker.items = flat.map((entry) => {
            byId.set(entry.id, entry.symbol)
            return {
              id: entry.id,
              label: `${'  '.repeat(entry.depth)}${entry.symbol.name}`,
              iconId: `symbol-kind-${entry.symbol.kind}`,
            }
          })
        }),
      )

      store.add(
        picker.onDidChangeActive((item) => {
          const symbol = item ? byId.get(item.id) : undefined
          if (symbol) outline.previewSymbol(symbol)
        }),
      )
      store.add(
        picker.onDidAccept((items) => {
          accepted = true
          const symbol = items[0] ? byId.get(items[0].id) : undefined
          if (symbol) outline.revealSymbol(symbol)
          resolveOnce()
        }),
      )
      store.add(
        picker.onDidHide(() => {
          if (!accepted && initial) outline.restoreViewState(initial)
          resolveOnce()
        }),
      )

      picker.show()
    })
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
