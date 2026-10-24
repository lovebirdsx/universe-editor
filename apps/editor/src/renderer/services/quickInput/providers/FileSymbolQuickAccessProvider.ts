/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Go to Symbol in Editor quick access: '@' (flat, document order) and '@:'
 *  (grouped by symbol kind). Both list the active editor's document symbols from
 *  IOutlineService with live preview, mirroring VSCode's gotoSymbol quick access.
 *  Panel-side fuzzy filtering against the query (prefix stripped by the panel).
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  IEditorGroupsService,
  IInstantiationService,
  IUriIdentityService,
  localize,
  toDisposable,
  type IQuickAccessProvider,
  type IQuickAccessProviderRunOptions,
  type IQuickPick,
  type IQuickPickItem,
  type IQuickPickSeparator,
  type QuickPickInput,
} from '@universe-editor/platform'
import { IOutlineService } from '../../languageFeatures/OutlineService.js'
import {
  flattenOutline,
  groupSymbolsByKind,
  type FlatSymbol,
} from '../../languageFeatures/outlineFlatten.js'
import { ACP_OUTLINE_LANGUAGE_ID, isAcpSubagentKind } from '../../acp/session/acpTimelineOutline.js'
import { AcpSessionEditorInput } from '../../acp/session/acpSessionEditorInput.js'
import { SYMBOL_SUBAGENT_ICON_ID, symbolIconId } from '../../../workbench/symbols/symbolIcon.js'
import type { monaco } from '../../../workbench/editor/monaco/MonacoLoader.js'
import { resolveQuickPickOpenTarget, type TargetedOpen } from '../../editor/openTarget.js'
import {
  openExistingInputWithTarget,
  type OpenTargetServices,
} from '../../editor/openWithTarget.js'
import { revealSelectionInInput } from '../../editor/revealEditorPosition.js'
import { IAuxiliaryEditorWindowService } from '../../windows/auxiliaryEditorWindowService.js'

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

/** Sentinel kind 110 is reserved by the agent-session outline; gate on the
 *  language too so a future outline source cannot get pinned by accident. */
function isSubagentEntry(entry: FlatSymbol, languageId: string | undefined): boolean {
  return languageId === ACP_OUTLINE_LANGUAGE_ID && isAcpSubagentKind(entry.symbol.kind)
}

function symbolPickItem(
  entry: FlatSymbol,
  languageId: string | undefined,
  indent: boolean,
): IQuickPickItem {
  // The detail rides along as a (non-rendered) keyword so non-text outlines can
  // be searched by it — e.g. a graph commit is findable by hash or author.
  const detail = entry.symbol.detail
  return {
    id: entry.id,
    label: indent ? `${'  '.repeat(entry.depth)}${entry.symbol.name}` : entry.symbol.name,
    iconId: isSubagentEntry(entry, languageId)
      ? SYMBOL_SUBAGENT_ICON_ID
      : symbolIconId(entry.symbol.kind, languageId),
    ...(detail !== '' ? { description: detail, keywords: [detail] } : {}),
  }
}

const SUBAGENT_SECTION_ID = 'symbol-subagents'
const SUBAGENT_SECTION_LABEL = localize('fileSymbol.subAgents', 'Sub Agents')
const OTHER_SECTION_ID = 'symbol-other'
const OTHER_SECTION_LABEL = localize('fileSymbol.otherSymbols', 'Other symbols')

/** Split agent-session sub-agent cards out of the document-order list so both
 *  pickers can pin them above the rest. */
function splitSubagentSymbols(
  flat: readonly FlatSymbol[],
  languageId: string | undefined,
): {
  subagents: readonly FlatSymbol[]
  rest: readonly FlatSymbol[]
} {
  const subagents: FlatSymbol[] = []
  const rest: FlatSymbol[] = []
  for (const entry of flat) {
    ;(isSubagentEntry(entry, languageId) ? subagents : rest).push(entry)
  }
  return { subagents, rest }
}

function subagentSectionSeparator(): IQuickPickSeparator {
  return {
    type: 'separator',
    id: SUBAGENT_SECTION_ID,
    label: SUBAGENT_SECTION_LABEL,
  }
}

/** Label the rest section too: an unlabelled separator at the top of a filtered
 *  list would render as a blank 30px row when no sub-agent row matches. */
function otherSectionSeparator(): IQuickPickSeparator {
  return {
    type: 'separator',
    id: OTHER_SECTION_ID,
    label: OTHER_SECTION_LABEL,
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
  openInTarget?: (
    symbol: monaco.languages.DocumentSymbol,
    target: TargetedOpen,
  ) => void | Promise<void>,
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

  // Freeze after the first non-empty population: live-updating while the
  // picker is open (e.g. a running session's timeline outline) makes the list
  // jump under the user. An empty list stays subscribed so late-arriving
  // symbols (e.g. a just-opened file) still populate once.
  let frozen = false
  disposables.add(
    autorun((r) => {
      if (frozen) return
      const model = outline.outline.read(r)
      const flat = model ? flattenOutline(model.roots) : []
      byId.clear()
      const items = buildItems(flat, model?.languageId, byId)
      picker.items = items
      if (items.length > 0) frozen = true
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
      const target = resolveQuickPickOpenTarget(picker.keyMods)
      accepted = true
      picker.hide()
      if (!symbol) return
      if (target === 'default') outline.revealSymbol(symbol)
      else void openInTarget?.(symbol, target)
    }),
  )
}

/** Open the active editor in a side group / auxiliary window, then reveal the
 *  chosen symbol there. The active input is moved or cloned — never shared. */
function openSymbolInTarget(
  services: OpenTargetServices,
  symbol: monaco.languages.DocumentSymbol,
  target: TargetedOpen,
): void {
  const source = services.groups.activeGroup
  const active = source.activeEditor
  if (!active) return
  void (async () => {
    const result = await openExistingInputWithTarget(services, active, source, target, {
      pinned: true,
      // A session is globally unique: cloning it would attach the same
      // conversation twice. Move it instead.
      singleton: active instanceof AcpSessionEditorInput,
    })
    if (!result.handled || !result.editor) return
    const range = symbol.selectionRange ?? symbol.range
    void revealSelectionInInput(result.editor, {
      startLineNumber: range.startLineNumber,
      startColumn: range.startColumn,
    })
  })()
}

/** '@' — flat document-order symbol list with indentation showing nesting. */
export class FileSymbolQuickAccessProvider implements IQuickAccessProvider {
  private readonly _targets: OpenTargetServices | undefined

  constructor(
    @IOutlineService private readonly _outline: IOutlineService,
    @IEditorGroupsService groups?: IEditorGroupsService,
    @IInstantiationService inst?: IInstantiationService,
    @IUriIdentityService uriIdentity?: IUriIdentityService,
    @IAuxiliaryEditorWindowService aux?: IAuxiliaryEditorWindowService,
  ) {
    this._targets =
      groups && inst && uriIdentity && aux ? { groups, aux, inst, uriIdentity } : undefined
  }

  provide(picker: IQuickPick<IQuickPickItem>, options: IQuickAccessProviderRunOptions): void {
    const targets = this._targets
    provideFileSymbols(
      picker,
      options,
      this._outline,
      (flat, languageId, byId) => {
        const { subagents, rest } = splitSubagentSymbols(flat, languageId)
        if (subagents.length === 0) {
          return flat.map((entry) => {
            byId.set(entry.id, entry.symbol)
            return symbolPickItem(entry, languageId, true)
          })
        }
        const rows: QuickPickInput<IQuickPickItem>[] = [subagentSectionSeparator()]
        for (const entry of subagents) {
          byId.set(entry.id, entry.symbol)
          rows.push(symbolPickItem(entry, languageId, false))
        }
        // The rest section gets its own header so an empty sub-agent section can
        // drop out during filtering without leaving a blank divider at the top.
        rows.push(otherSectionSeparator())
        for (const entry of rest) {
          byId.set(entry.id, entry.symbol)
          rows.push(symbolPickItem(entry, languageId, true))
        }
        return rows
      },
      targets ? (symbol, target) => openSymbolInTarget(targets, symbol, target) : undefined,
    )
  }
}

/** '@:' — same symbols grouped under a separator per symbol kind. */
export class FileSymbolByCategoryQuickAccessProvider implements IQuickAccessProvider {
  private readonly _targets: OpenTargetServices | undefined

  constructor(
    @IOutlineService private readonly _outline: IOutlineService,
    @IEditorGroupsService groups?: IEditorGroupsService,
    @IInstantiationService inst?: IInstantiationService,
    @IUriIdentityService uriIdentity?: IUriIdentityService,
    @IAuxiliaryEditorWindowService aux?: IAuxiliaryEditorWindowService,
  ) {
    this._targets =
      groups && inst && uriIdentity && aux ? { groups, aux, inst, uriIdentity } : undefined
  }

  provide(picker: IQuickPick<IQuickPickItem>, options: IQuickAccessProviderRunOptions): void {
    const targets = this._targets
    provideFileSymbols(
      picker,
      options,
      this._outline,
      (flat, languageId, byId) => {
        const { subagents, rest } = splitSubagentSymbols(flat, languageId)
        const rows: QuickPickInput<IQuickPickItem>[] = []
        if (subagents.length > 0) {
          rows.push(subagentSectionSeparator())
          for (const entry of subagents) {
            byId.set(entry.id, entry.symbol)
            rows.push(symbolPickItem(entry, languageId, false))
          }
        }
        for (const group of groupSymbolsByKind(rest)) {
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
      },
      targets ? (symbol, target) => openSymbolInTarget(targets, symbol, target) : undefined,
    )
  }
}
