/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Symbol navigation pickers backed by our own quick pick:
 *    - Go to Symbol in Workspace (Ctrl+T) — markdown language server workspace
 *      symbols. Mirrors VSCode's `workbench.action.showAllSymbols`.
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
  IInstantiationService,
  IQuickInputService,
  IWorkspaceService,
  URI,
  autorun,
  localize,
  type IQuickPickItem,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'
import { IOutlineService } from '../services/languageFeatures/OutlineService.js'
import { flattenOutline } from '../services/languageFeatures/outlineFlatten.js'
import { type monaco } from '../workbench/editor/monaco/MonacoLoader.js'
import {
  IMarkdownLanguageService,
  type MdWorkspaceSymbol,
} from '../../shared/ipc/markdownLanguageService.js'

const SEARCH_DELAY_MS = 200
const MAX_RESULTS = 512

function relativePath(root: URI | undefined, uri: URI): string {
  if (!root) return uri.fsPath
  const rootPath = root.fsPath.replace(/\\/g, '/').replace(/\/$/, '')
  const norm = uri.fsPath.replace(/\\/g, '/')
  return norm.startsWith(rootPath + '/') ? norm.slice(rootPath.length + 1) : uri.fsPath
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

    const root = workspace.current?.folder
    await md.ensureStarted(root?.fsPath)

    const picker = quickInput.createQuickPick<IQuickPickItem>()
    picker.placeholder = localize(
      'quickInput.showAllSymbols.placeholder',
      'Go to Symbol in Workspace…',
    )
    picker.filterExternally = true

    /** Pick id → symbol, so onDidAccept can recover the target location. */
    const byId = new Map<string, MdWorkspaceSymbol>()

    await new Promise<void>((resolve) => {
      const store = new DisposableStore()
      let timer: ReturnType<typeof setTimeout> | undefined
      let requestSeq = 0
      let accepted = false
      let didResolve = false

      const cleanup = (): void => {
        requestSeq++
        if (timer !== undefined) clearTimeout(timer)
        store.dispose()
        picker.dispose()
      }
      const resolveOnce = (): void => {
        if (didResolve) return
        didResolve = true
        cleanup()
        resolve()
      }

      const runSearch = async (value: string): Promise<void> => {
        const seq = ++requestSeq
        const query = value.trim()
        if (query.length === 0) {
          picker.busy = false
          picker.items = []
          byId.clear()
          return
        }
        picker.busy = true
        try {
          const symbols = await md.provideWorkspaceSymbols(query)
          if (seq !== requestSeq) return
          byId.clear()
          picker.items = symbols.slice(0, MAX_RESULTS).map((symbol, i) => {
            const id = String(i)
            byId.set(id, symbol)
            const uri = URI.parse(symbol.location.uri)
            return {
              id,
              label: symbol.name,
              // MdWorkspaceSymbol.kind is LSP 1-based; the icon resolver expects
              // Monaco 0-based, matching the file-symbol path.
              iconId: `symbol-kind-${symbol.kind - 1}`,
              description: relativePath(root, uri),
            }
          })
        } finally {
          if (seq === requestSeq) picker.busy = false
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
        }, SEARCH_DELAY_MS)
      }

      const openSymbol = (symbol: MdWorkspaceSymbol): void => {
        const uri = URI.parse(symbol.location.uri)
        const lineNumber = symbol.location.range.start.line + 1
        const column = symbol.location.range.start.character + 1

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
        void revealPosition(input, lineNumber, column)
      }

      store.add(picker.onDidChangeValue(scheduleSearch))
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

      picker.show()
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
