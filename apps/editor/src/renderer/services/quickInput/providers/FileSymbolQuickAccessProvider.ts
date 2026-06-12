/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Go to Symbol in Editor quick access: '@' (flat, document order) and '@:'
 *  (grouped by symbol kind). Both list the active editor's document symbols from
 *  IOutlineService with live preview, mirroring VSCode's gotoSymbol quick access.
 *  Panel-side fuzzy filtering against the query (prefix stripped by the panel).
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  localize,
  toDisposable,
  type IQuickAccessProvider,
  type IQuickAccessProviderRunOptions,
  type IQuickPick,
  type IQuickPickItem,
  type QuickPickInput,
} from '@universe-editor/platform'
import { IOutlineService } from '../../languageFeatures/OutlineService.js'
import {
  flattenOutline,
  groupSymbolsByKind,
  type FlatSymbol,
} from '../../languageFeatures/outlineFlatten.js'
import { symbolIconId } from '../../../workbench/symbols/symbolIcon.js'
import type { monaco } from '../../../workbench/editor/monaco/MonacoLoader.js'

/** Plural category names for '@:' separators, keyed by Monaco 0-based SymbolKind. */
const SYMBOL_KIND_PLURAL: Record<number, string> = {
  0: localize('symbolKind.files', 'files'),
  1: localize('symbolKind.modules', 'modules'),
  2: localize('symbolKind.namespaces', 'namespaces'),
  3: localize('symbolKind.packages', 'packages'),
  4: localize('symbolKind.classes', 'classes'),
  5: localize('symbolKind.methods', 'methods'),
  6: localize('symbolKind.properties', 'properties'),
  7: localize('symbolKind.fields', 'fields'),
  8: localize('symbolKind.constructors', 'constructors'),
  9: localize('symbolKind.enums', 'enumerations'),
  10: localize('symbolKind.interfaces', 'interfaces'),
  11: localize('symbolKind.functions', 'functions'),
  12: localize('symbolKind.variables', 'variables'),
  13: localize('symbolKind.constants', 'constants'),
  14: localize('symbolKind.strings', 'strings'),
  15: localize('symbolKind.numbers', 'numbers'),
  16: localize('symbolKind.booleans', 'booleans'),
  17: localize('symbolKind.arrays', 'arrays'),
  18: localize('symbolKind.objects', 'objects'),
  19: localize('symbolKind.keys', 'keys'),
  20: localize('symbolKind.nulls', 'nulls'),
  21: localize('symbolKind.enumMembers', 'enumeration members'),
  22: localize('symbolKind.structs', 'structs'),
  23: localize('symbolKind.events', 'events'),
  24: localize('symbolKind.operators', 'operators'),
  25: localize('symbolKind.typeParameters', 'type parameters'),
}

function symbolKindLabel(kind: number): string {
  return SYMBOL_KIND_PLURAL[kind] ?? localize('symbolKind.misc', 'other')
}

function symbolPickItem(
  entry: FlatSymbol,
  languageId: string | undefined,
  indent: boolean,
): IQuickPickItem {
  return {
    id: entry.id,
    label: indent ? `${'  '.repeat(entry.depth)}${entry.symbol.name}` : entry.symbol.name,
    iconId: symbolIconId(entry.symbol.kind, languageId),
  }
}

/**
 * Drive the shared picker against the outline. `buildItems` turns the flattened
 * symbol list into the panel rows ('@' indents in document order; '@:' inserts a
 * separator per kind). Cancelling (hide/switch without accept) restores the view.
 */
function provideFileSymbols(
  picker: IQuickPick<IQuickPickItem>,
  options: IQuickAccessProviderRunOptions,
  outline: IOutlineService,
  buildItems: (
    flat: readonly FlatSymbol[],
    languageId: string | undefined,
    byId: Map<string, monaco.languages.DocumentSymbol>,
  ) => readonly QuickPickInput<IQuickPickItem>[],
): void {
  const { disposables } = options
  const byId = new Map<string, monaco.languages.DocumentSymbol>()
  const initial = outline.captureViewState()
  let accepted = false

  // Restore the original view if the picker is dismissed/switched without
  // accepting; accepting reveals the chosen symbol and must not be undone.
  if (initial) {
    disposables.add(
      toDisposable(() => {
        if (!accepted) outline.restoreViewState(initial)
      }),
    )
  }

  // Keep the list in sync with the outline (symbols may arrive after open, e.g.
  // a just-opened file). The editor isn't edited while focused here, so this
  // effectively runs once.
  disposables.add(
    autorun((r) => {
      const model = outline.outline.read(r)
      const flat = model ? flattenOutline(model.roots) : []
      byId.clear()
      picker.items = buildItems(flat, model?.languageId, byId)
    }),
  )

  disposables.add(
    picker.onDidChangeActive((item) => {
      const symbol = item ? byId.get(item.id) : undefined
      if (symbol) outline.previewSymbol(symbol)
    }),
  )
  disposables.add(
    picker.onDidAccept((items) => {
      const symbol = items[0] ? byId.get(items[0].id) : undefined
      accepted = true
      if (symbol) outline.revealSymbol(symbol)
      picker.hide()
    }),
  )
}

/** '@' — flat document-order symbol list with indentation showing nesting. */
export class FileSymbolQuickAccessProvider implements IQuickAccessProvider {
  constructor(@IOutlineService private readonly _outline: IOutlineService) {}

  provide(picker: IQuickPick<IQuickPickItem>, options: IQuickAccessProviderRunOptions): void {
    provideFileSymbols(picker, options, this._outline, (flat, languageId, byId) =>
      flat.map((entry) => {
        byId.set(entry.id, entry.symbol)
        return symbolPickItem(entry, languageId, true)
      }),
    )
  }
}

/** '@:' — same symbols grouped under a separator per symbol kind. */
export class FileSymbolByCategoryQuickAccessProvider implements IQuickAccessProvider {
  constructor(@IOutlineService private readonly _outline: IOutlineService) {}

  provide(picker: IQuickPick<IQuickPickItem>, options: IQuickAccessProviderRunOptions): void {
    provideFileSymbols(picker, options, this._outline, (flat, languageId, byId) => {
      const rows: QuickPickInput<IQuickPickItem>[] = []
      for (const group of groupSymbolsByKind(flat)) {
        rows.push({
          type: 'separator',
          id: `kind-${group.kind}`,
          label: symbolKindLabel(group.kind),
        })
        for (const entry of group.symbols) {
          byId.set(entry.id, entry.symbol)
          rows.push(symbolPickItem(entry, languageId, false))
        }
      }
      return rows
    })
  }
}
