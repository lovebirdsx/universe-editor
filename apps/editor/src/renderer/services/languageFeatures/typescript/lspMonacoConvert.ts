/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure converters between standard-LSP wire types (0-based) and Monaco types
 *  (1-based) for the TS/JS language service. Range/symbol/diagnostic conversions
 *  are Monaco-runtime-free; the ones that build a Uri or read a runtime enum take
 *  the monaco namespace. Wire URI strings are parsed through parseWireUri, which
 *  reads the window-level wire URI space (see wireUri.ts), so these converters
 *  depend on that ambient module state. Tested in isolation (lspMonacoConvert.test.ts).
 *--------------------------------------------------------------------------------------------*/

import { type monaco } from '../../../workbench/editor/monaco/MonacoLoader.js'
import { parseWireUri } from './wireUri.js'
import type { IInlayHintDto } from '@universe-editor/extensions-common'
import type {
  CodeAction,
  CodeLens,
  Command,
  CompletionItem,
  CompletionList,
  Definition,
  DefinitionLink,
  Diagnostic,
  DocumentHighlight,
  DocumentLink,
  DocumentSymbol,
  FoldingRange,
  Hover,
  InlayHintLabelPart,
  Location,
  LocationLink,
  Position,
  Range,
  SelectionRange,
  SemanticTokens,
  SignatureHelp,
  SymbolInformation,
  TextEdit,
  WorkspaceEdit,
  WorkspaceSymbol,
} from 'vscode-languageserver-types'

/** LSP 0-based range → Monaco 1-based range. */
export function rangeToMonaco(r: Range): monaco.IRange {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  }
}

/** LSP TextEdit[] → Monaco `languages.TextEdit[]` (range 0-based → 1-based). Used
 *  by document-formatting providers, whose result is a set of edits over the doc. */
export function textEditsToMonaco(edits: TextEdit[] | null): monaco.languages.TextEdit[] {
  if (!edits) return []
  return edits.map((e) => ({ range: rangeToMonaco(e.range), text: e.newText }))
}

/** Monaco 1-based position → LSP 0-based position. */
export function monacoPositionToLsp(p: monaco.IPosition): Position {
  return { line: p.lineNumber - 1, character: p.column - 1 }
}

/** Monaco 1-based range → LSP 0-based range. */
export function monacoRangeToLsp(r: monaco.IRange): Range {
  return {
    start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
    end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
  }
}

/** LSP SymbolKind (1-based) → Monaco SymbolKind (0-based) — a simple offset. */
function symbolKindToMonaco(kind: number): monaco.languages.SymbolKind {
  return Math.max(0, kind - 1) as monaco.languages.SymbolKind
}

/** LSP DocumentSymbol (hierarchical) → Monaco DocumentSymbol. */
export function documentSymbolToMonaco(s: DocumentSymbol): monaco.languages.DocumentSymbol {
  return {
    name: s.name || '(empty)',
    detail: s.detail ?? '',
    kind: symbolKindToMonaco(s.kind),
    tags: s.tags ? [...s.tags] : [],
    range: rangeToMonaco(s.range),
    selectionRange: rangeToMonaco(s.selectionRange),
    ...(s.children ? { children: s.children.map(documentSymbolToMonaco) } : {}),
  }
}

/**
 * LSP SymbolInformation (flat, with a Location) → Monaco DocumentSymbol. Used
 * when the server answers documentSymbol with the legacy flat shape; the whole
 * location range doubles as both range and selectionRange.
 */
export function symbolInformationToMonaco(s: SymbolInformation): monaco.languages.DocumentSymbol {
  const range = rangeToMonaco(s.location.range)
  return {
    name: s.name || '(empty)',
    detail: '',
    kind: symbolKindToMonaco(s.kind),
    tags: s.tags ? [...s.tags] : [],
    range,
    selectionRange: range,
  }
}

function isDocumentSymbolArray(
  symbols: DocumentSymbol[] | SymbolInformation[],
): symbols is DocumentSymbol[] {
  // DocumentSymbol has `selectionRange`; SymbolInformation has `location`.
  return symbols.length === 0 || 'selectionRange' in symbols[0]!
}

export function documentSymbolsToMonaco(
  symbols: DocumentSymbol[] | SymbolInformation[] | null,
): monaco.languages.DocumentSymbol[] {
  if (!symbols) return []
  return isDocumentSymbolArray(symbols)
    ? symbols.map(documentSymbolToMonaco)
    : symbols.map(symbolInformationToMonaco)
}

export function locationToMonaco(l: Location, monacoNs: typeof monaco): monaco.languages.Location {
  return { uri: parseWireUri(monacoNs, l.uri), range: rangeToMonaco(l.range) }
}

function isLocationLink(x: Location | LocationLink): x is LocationLink {
  return 'targetUri' in x
}

function locationLinkToMonaco(
  l: LocationLink,
  monacoNs: typeof monaco,
): monaco.languages.LocationLink {
  return {
    uri: parseWireUri(monacoNs, l.targetUri),
    range: rangeToMonaco(l.targetRange),
    targetSelectionRange: rangeToMonaco(l.targetSelectionRange),
    ...(l.originSelectionRange
      ? { originSelectionRange: rangeToMonaco(l.originSelectionRange) }
      : {}),
  }
}

/** LSP definition result (Location | Location[] | LocationLink[]) → Monaco. */
export function definitionToMonaco(
  def: Definition | DefinitionLink[] | null,
  monacoNs: typeof monaco,
): monaco.languages.Definition | monaco.languages.LocationLink[] {
  if (!def) return []
  const arr = Array.isArray(def) ? def : [def]
  return arr.map((l) =>
    isLocationLink(l) ? locationLinkToMonaco(l, monacoNs) : locationToMonaco(l, monacoNs),
  )
}

export function locationsToMonaco(
  locs: Location[] | null,
  monacoNs: typeof monaco,
): monaco.languages.Location[] {
  if (!locs) return []
  return locs.map((l) => locationToMonaco(l, monacoNs))
}

/** LSP Hover contents (MarkupContent | MarkedString | MarkedString[]) → Monaco. */
export function hoverToMonaco(h: Hover | null): monaco.languages.Hover | null {
  if (!h) return null
  const contents: monaco.IMarkdownString[] = []
  const raw = h.contents
  const push = (m: unknown): void => {
    if (typeof m === 'string') {
      contents.push({ value: m })
    } else if (m && typeof m === 'object') {
      const obj = m as { kind?: string; language?: string; value?: string }
      if (obj.language !== undefined) {
        contents.push({ value: '```' + obj.language + '\n' + (obj.value ?? '') + '\n```' })
      } else if (obj.value !== undefined) {
        contents.push({ value: obj.value })
      }
    }
  }
  if (Array.isArray(raw)) raw.forEach(push)
  else push(raw)
  return {
    contents,
    ...(h.range ? { range: rangeToMonaco(h.range) } : {}),
  }
}

/**
 * LSP CompletionItemKind (1-based) → Monaco CompletionItemKind. Monaco's enum is
 * ordered differently, so this is an explicit table, not an offset.
 */
function completionKindToMonaco(
  kind: number | undefined,
  monacoNs: typeof monaco,
): monaco.languages.CompletionItemKind {
  const K = monacoNs.languages.CompletionItemKind
  switch (kind) {
    case 1:
      return K.Text
    case 2:
      return K.Method
    case 3:
      return K.Function
    case 4:
      return K.Constructor
    case 5:
      return K.Field
    case 6:
      return K.Variable
    case 7:
      return K.Class
    case 8:
      return K.Interface
    case 9:
      return K.Module
    case 10:
      return K.Property
    case 11:
      return K.Unit
    case 12:
      return K.Value
    case 13:
      return K.Enum
    case 14:
      return K.Keyword
    case 15:
      return K.Snippet
    case 16:
      return K.Color
    case 17:
      return K.File
    case 18:
      return K.Reference
    case 19:
      return K.Folder
    case 20:
      return K.EnumMember
    case 21:
      return K.Constant
    case 22:
      return K.Struct
    case 23:
      return K.Event
    case 24:
      return K.Operator
    case 25:
      return K.TypeParameter
    default:
      return K.Property
  }
}

function textEditToMonaco(e: TextEdit): { range: monaco.IRange; text: string } {
  return { range: rangeToMonaco(e.range), text: e.newText }
}

/** Monaco completion item carrying its source LSP item for the resolve round-trip. */
export interface MonacoCompletionItem extends monaco.languages.CompletionItem {
  /** Original LSP item; passed back verbatim to completionItem/resolve. */
  _lspItem: CompletionItem
}

/**
 * LSP CompletionItem → Monaco CompletionItem. `defaultRange` is the word range at
 * the cursor, used when the item has no explicit textEdit (Monaco requires a
 * range on every suggestion). The original LSP item rides along on `_lspItem` so
 * the resolve provider can ask the server to fill in documentation / imports.
 */
export function completionItemToMonaco(
  item: CompletionItem,
  defaultRange: monaco.IRange,
  monacoNs: typeof monaco,
): MonacoCompletionItem {
  const isSnippet = item.insertTextFormat === 2
  let range: monaco.languages.CompletionItem['range'] = defaultRange
  let insertText = item.insertText ?? item.label
  const edit = item.textEdit
  if (edit) {
    insertText = edit.newText
    if ('range' in edit) {
      range = rangeToMonaco(edit.range)
    } else {
      // InsertReplaceEdit: Monaco accepts {insert, replace}.
      range = { insert: rangeToMonaco(edit.insert), replace: rangeToMonaco(edit.replace) }
    }
  }
  const documentation = documentationToMonaco(item.documentation)
  const out: MonacoCompletionItem = {
    label: item.label,
    kind: completionKindToMonaco(item.kind, monacoNs),
    insertText,
    range,
    _lspItem: item,
    ...(item.detail !== undefined ? { detail: item.detail } : {}),
    ...(isSnippet
      ? { insertTextRules: monacoNs.languages.CompletionItemInsertTextRule.InsertAsSnippet }
      : {}),
    ...(item.sortText !== undefined ? { sortText: item.sortText } : {}),
    ...(item.filterText !== undefined ? { filterText: item.filterText } : {}),
    ...(item.preselect !== undefined ? { preselect: item.preselect } : {}),
    ...(item.commitCharacters ? { commitCharacters: [...item.commitCharacters] } : {}),
    ...(item.additionalTextEdits
      ? { additionalTextEdits: item.additionalTextEdits.map(textEditToMonaco) }
      : {}),
    ...(item.command
      ? {
          command: {
            id: item.command.command,
            title: item.command.title,
            ...(item.command.arguments ? { arguments: [...item.command.arguments] } : {}),
          },
        }
      : {}),
    ...(documentation !== undefined ? { documentation } : {}),
  }
  return out
}

function documentationToMonaco(
  doc: CompletionItem['documentation'],
): string | monaco.IMarkdownString | undefined {
  if (doc === undefined) return undefined
  if (typeof doc === 'string') return doc
  return { value: doc.value }
}

export function completionListToMonaco(
  result: CompletionItem[] | CompletionList | null,
  defaultRange: monaco.IRange,
  monacoNs: typeof monaco,
): monaco.languages.CompletionList {
  if (!result) return { suggestions: [] }
  const items = Array.isArray(result) ? result : result.items
  const incomplete = Array.isArray(result) ? false : result.isIncomplete
  return {
    suggestions: items.map((i) => completionItemToMonaco(i, defaultRange, monacoNs)),
    incomplete,
  }
}

/** Merge a resolved LSP item's richer fields back onto the Monaco item. */
export function applyResolvedCompletion(
  monacoItem: MonacoCompletionItem,
  resolved: CompletionItem,
): monaco.languages.CompletionItem {
  const merged: monaco.languages.CompletionItem = { ...monacoItem }
  if (resolved.detail !== undefined) merged.detail = resolved.detail
  const doc = documentationToMonaco(resolved.documentation)
  if (doc !== undefined) merged.documentation = doc
  if (resolved.additionalTextEdits) {
    merged.additionalTextEdits = resolved.additionalTextEdits.map(textEditToMonaco)
  }
  return merged
}

export function signatureHelpToMonaco(
  help: SignatureHelp | null,
): monaco.languages.SignatureHelpResult | null {
  if (!help) return null
  return {
    value: {
      signatures: help.signatures.map((s) => {
        const documentation = documentationToMonaco(s.documentation)
        return {
          label: s.label,
          ...(documentation !== undefined ? { documentation } : {}),
          parameters: (s.parameters ?? []).map((p) => {
            const paramDoc = documentationToMonaco(p.documentation)
            return {
              label: p.label,
              ...(paramDoc !== undefined ? { documentation: paramDoc } : {}),
            }
          }),
          ...(s.activeParameter != null ? { activeParameter: s.activeParameter } : {}),
        }
      }),
      activeSignature: help.activeSignature ?? 0,
      activeParameter: help.activeParameter ?? 0,
    },
    dispose: () => undefined,
  }
}

/**
 * LSP DiagnosticSeverity (1 Error / 2 Warning / 3 Information / 4 Hint) → Monaco
 * MarkerSeverity (8 / 4 / 2 / 1). Tags (1 Unnecessary / 2 Deprecated) map onto
 * MarkerTag values of the same name.
 */
export function diagnosticToMarker(
  d: Diagnostic,
  monacoNs: typeof monaco,
): monaco.editor.IMarkerData {
  const S = monacoNs.MarkerSeverity
  const severity =
    d.severity === 1 ? S.Error : d.severity === 3 ? S.Info : d.severity === 4 ? S.Hint : S.Warning
  const tags = (d.tags ?? [])
    .map((t) =>
      t === 1
        ? monacoNs.MarkerTag.Unnecessary
        : t === 2
          ? monacoNs.MarkerTag.Deprecated
          : undefined,
    )
    .filter((t): t is monaco.MarkerTag => t !== undefined)
  return {
    severity,
    message: typeof d.message === 'string' ? d.message : d.message.value,
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
    ...(d.source ? { source: d.source } : {}),
    ...(d.code !== undefined ? { code: codeForMarker(d, monacoNs) } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  }
}

/** A diagnostic `code` becomes a plain string, or a `{ value, target }` link when
 *  the server sent a `codeDescription.href` (LSP 3.16) — Monaco renders that as a
 *  clickable "open rule documentation" link in the marker (used by ESLint). */
function codeForMarker(
  d: Diagnostic,
  monacoNs: typeof monaco,
): string | { value: string; target: monaco.Uri } {
  const value = String(d.code)
  const href = d.codeDescription?.href
  return href ? { value, target: parseWireUri(monacoNs, href) } : value
}

/** Monaco MarkerSeverity (8 Error / 4 Warning / 2 Info / 1 Hint) → LSP DiagnosticSeverity. */
const LSP_SEVERITY_BY_MARKER: { readonly [severity: number]: 1 | 2 | 3 | 4 } = {
  8: 1,
  4: 2,
  2: 3,
  1: 4,
}

/**
 * Monaco IMarker → LSP Diagnostic — the inverse of {@link diagnosticToMarker}
 * (MarkerSeverity 8/4/2/1 → 1/2/3/4, 1-based positions → 0-based). Unknown
 * severities fall back to Error, matching Monaco's own marker→problem mapping. A
 * `{ value, target }` code round-trips into `code` + `codeDescription.href`;
 * tags round-trip into LSP DiagnosticTags (numerically identical to MarkerTags,
 * so a plain type-guard keeps the known ones). `relatedInformation` is dropped
 * (the forward mapping never carries it).
 */
export function markerToLspDiagnostic(m: monaco.editor.IMarker): Diagnostic {
  const severity = LSP_SEVERITY_BY_MARKER[m.severity] ?? 1
  const tags = (m.tags ?? []).filter((t): t is 1 | 2 => t === 1 || t === 2)
  // VSCode parity: the marker holds the stringified code and VSCode's own
  // reverse converter always returns that string, never re-numericising it.
  // Keeping the string preserves leading zeros ('0123' must not come back as
  // 123); a published numeric code reads back in its string form — the same
  // loss `languages.getDiagnostics` has in VSCode.
  const code = m.code === undefined ? undefined : typeof m.code === 'string' ? m.code : m.code.value
  return {
    range: {
      start: { line: m.startLineNumber - 1, character: m.startColumn - 1 },
      end: { line: m.endLineNumber - 1, character: m.endColumn - 1 },
    },
    message: m.message,
    severity,
    ...(m.source !== undefined ? { source: m.source } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(typeof m.code === 'object' ? { codeDescription: { href: m.code.target.toString() } } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  }
}

/**
 * LSP WorkspaceEdit (changes map and/or documentChanges) → Monaco WorkspaceEdit.
 * Text edits and create/rename/delete file operations are both converted; the
 * `documentChanges` order is preserved so interleaved operations apply in the
 * sequence the server listed them.
 */
export function workspaceEditToMonaco(
  edit: WorkspaceEdit | null,
  monacoNs: typeof monaco,
): monaco.languages.WorkspaceEdit {
  const edits: (monaco.languages.IWorkspaceTextEdit | monaco.languages.IWorkspaceFileEdit)[] = []
  if (!edit) return { edits }

  const pushEdits = (uri: string, textEdits: TextEdit[], version?: number | null): void => {
    const resource = parseWireUri(monacoNs, uri)
    for (const e of textEdits) {
      edits.push({
        resource,
        textEdit: { range: rangeToMonaco(e.range), text: e.newText },
        versionId: version ?? undefined,
      })
    }
  }

  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ('textDocument' in change && 'edits' in change) {
        pushEdits(change.textDocument.uri, change.edits as TextEdit[], change.textDocument.version)
      } else if ('kind' in change) {
        const fileEdit = resourceOperationToMonaco(change, monacoNs)
        if (fileEdit) edits.push(fileEdit)
      }
    }
  } else if (edit.changes) {
    for (const [uri, textEdits] of Object.entries(edit.changes)) {
      pushEdits(uri, textEdits)
    }
  }
  return { edits }
}

type ResourceOperation = Extract<
  NonNullable<WorkspaceEdit['documentChanges']>[number],
  { kind: string }
>

/** LSP CreateFile/RenameFile/DeleteFile → Monaco IWorkspaceFileEdit, options
 *  (overwrite / ignoreIfExists / ignoreIfNotExists / recursive) carried through. */
function resourceOperationToMonaco(
  op: ResourceOperation,
  monacoNs: typeof monaco,
): monaco.languages.IWorkspaceFileEdit | undefined {
  switch (op.kind) {
    case 'create':
      return {
        newResource: parseWireUri(monacoNs, op.uri),
        options: { ...op.options },
      }
    case 'rename':
      return {
        oldResource: parseWireUri(monacoNs, op.oldUri),
        newResource: parseWireUri(monacoNs, op.newUri),
        options: { ...op.options },
      }
    case 'delete':
      return {
        oldResource: parseWireUri(monacoNs, op.uri),
        options: { ...op.options },
      }
    default:
      return undefined
  }
}

/** A workspace symbol flattened for the Ctrl+T quick pick. */
export interface WorkspaceSymbolEntry {
  readonly name: string
  readonly kind: monaco.languages.SymbolKind
  readonly containerName: string
  readonly uri: monaco.Uri
  readonly range: monaco.IRange
}

export function workspaceSymbolsToEntries(
  symbols: WorkspaceSymbol[] | SymbolInformation[] | null,
  monacoNs: typeof monaco,
): WorkspaceSymbolEntry[] {
  if (!symbols) return []
  const out: WorkspaceSymbolEntry[] = []
  for (const s of symbols) {
    // WorkspaceSymbol.location may be a {uri} stub (no range) or a full Location.
    const loc = s.location
    const uri = parseWireUri(monacoNs, loc.uri)
    const range =
      'range' in loc
        ? rangeToMonaco(loc.range)
        : { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }
    out.push({
      name: s.name,
      kind: symbolKindToMonaco(s.kind),
      containerName: s.containerName ?? '',
      uri,
      range,
    })
  }
  return out
}

/** LSP folding-range kind (string) → Monaco FoldingRangeKind instance. */
function foldingRangeKindToMonaco(
  kind: string | undefined,
  monacoNs: typeof monaco,
): monaco.languages.FoldingRangeKind | undefined {
  switch (kind) {
    case 'comment':
      return monacoNs.languages.FoldingRangeKind.Comment
    case 'imports':
      return monacoNs.languages.FoldingRangeKind.Imports
    case 'region':
      return monacoNs.languages.FoldingRangeKind.Region
    default:
      return undefined
  }
}

/** LSP FoldingRange[] (0-based lines) → Monaco FoldingRange[] (1-based lines). */
export function foldingRangesToMonaco(
  ranges: FoldingRange[] | null,
  monacoNs: typeof monaco,
): monaco.languages.FoldingRange[] {
  if (!ranges) return []
  return ranges.map((r) => {
    const kind = foldingRangeKindToMonaco(r.kind, monacoNs)
    return {
      start: r.startLine + 1,
      end: r.endLine + 1,
      ...(kind ? { kind } : {}),
    }
  })
}

/**
 * Monaco link carrying the originating LSP link, so a two-stage provider can hand
 * the exact same object back for resolution (`_lspLink`), then map the resolved
 * `target` onto Monaco's `url` (a Uri Monaco's opener routes through the workbench
 * editor service). A link with no target yet stays unresolved (no `url`).
 */
export interface MonacoDocumentLink extends monaco.languages.ILink {
  _lspLink: DocumentLink
}

function documentLinkToMonaco(link: DocumentLink, monacoNs: typeof monaco): MonacoDocumentLink {
  return {
    range: rangeToMonaco(link.range),
    ...(link.target ? { url: parseWireUri(monacoNs, link.target) } : {}),
    ...(typeof link.tooltip === 'string' ? { tooltip: link.tooltip } : {}),
    _lspLink: link,
  }
}

export function documentLinksToMonaco(
  links: DocumentLink[] | null,
  monacoNs: typeof monaco,
): monaco.languages.ILinksList {
  if (!links) return { links: [] }
  return { links: links.map((l) => documentLinkToMonaco(l, monacoNs)) }
}

/** Map a resolved LSP link's `target` onto the Monaco link Monaco passes to `resolveLink`. */
export function resolvedDocumentLinkToMonaco(
  resolved: DocumentLink | null,
  original: monaco.languages.ILink,
  monacoNs: typeof monaco,
): monaco.languages.ILink {
  if (!resolved?.target) return original
  return { ...original, url: parseWireUri(monacoNs, resolved.target) }
}

/** LSP DocumentHighlight[] (kind 1/2/3) → Monaco (kind 0/1/2 — a simple offset). */
export function documentHighlightsToMonaco(
  highlights: DocumentHighlight[] | null,
): monaco.languages.DocumentHighlight[] {
  if (!highlights) return []
  return highlights.map((h) => ({
    range: rangeToMonaco(h.range),
    ...(h.kind ? { kind: (h.kind - 1) as monaco.languages.DocumentHighlightKind } : {}),
  }))
}

/**
 * LSP SelectionRange (a linked list via `parent`, one per requested position) →
 * Monaco `SelectionRange[][]` (per position, innermost-to-outermost). Flattens
 * each chain by walking `parent`.
 */
export function selectionRangesToMonaco(
  ranges: SelectionRange[] | null,
): monaco.languages.SelectionRange[][] {
  if (!ranges) return []
  return ranges.map((head) => {
    const chain: monaco.languages.SelectionRange[] = []
    let cur: SelectionRange | undefined = head
    while (cur) {
      chain.push({ range: rangeToMonaco(cur.range) })
      cur = cur.parent
    }
    return chain
  })
}

/** LSP CodeAction[] → Monaco CodeActionList. Edits/diagnostics converted; commands dropped. */
export function codeActionsToMonaco(
  actions: CodeAction[] | null,
  monacoNs: typeof monaco,
): monaco.languages.CodeActionList {
  if (!actions) return { actions: [], dispose: () => {} }
  const converted = actions.map((a): monaco.languages.CodeAction => {
    const diagnostics = a.diagnostics?.map((d) => diagnosticToMarker(d, monacoNs))
    return {
      title: a.title,
      ...(a.kind ? { kind: a.kind } : {}),
      ...(a.isPreferred ? { isPreferred: a.isPreferred } : {}),
      ...(a.edit ? { edit: workspaceEditToMonaco(a.edit, monacoNs) } : {}),
      ...(diagnostics && diagnostics.length > 0 ? { diagnostics } : {}),
      ...(a.disabled ? { disabled: a.disabled.reason } : {}),
    }
  })
  return { actions: converted, dispose: () => {} }
}

/**
 * LSP SemanticTokens → Monaco SemanticTokens. Both use the identical 5-tuple
 * delta encoding (deltaLine, deltaStartChar, length, tokenType, tokenModifiers),
 * so the token stream passes through verbatim — only the container type differs
 * (LSP `number[]` → Monaco's required `Uint32Array`). The legend (which names
 * these numeric indices) is supplied to Monaco separately at registration.
 */
export function semanticTokensToMonaco(
  tokens: SemanticTokens | null,
): monaco.languages.SemanticTokens | null {
  if (!tokens) return null
  return {
    data: Uint32Array.from(tokens.data),
    ...(tokens.resultId !== undefined ? { resultId: tokens.resultId } : {}),
  }
}

/**
 * A Monaco CodeLens carrying its originating LSP lens, so `resolveCodeLens` can
 * hand the exact server lens back for resolution (mirrors MonacoDocumentLink).
 */
export interface MonacoCodeLens extends monaco.languages.CodeLens {
  _lspLens: CodeLens
}

/**
 * LSP `editor.action.showReferences` (the only built-in command tsserver's
 * CodeLenses invoke) carries `[uri, position, locations]` in LSP shape; Monaco's
 * command expects a `monaco.Uri`, an `IPosition`, and Monaco locations. Convert
 * those args; any other command passes through verbatim (its handler owns the
 * arg shape).
 */
function commandToMonaco(command: Command, monacoNs: typeof monaco): monaco.languages.Command {
  const base: monaco.languages.Command = { id: command.command, title: command.title }
  if (command.command === 'editor.action.showReferences' && command.arguments) {
    const [uri, position, locations] = command.arguments as [string, Position, Location[]]
    return {
      ...base,
      arguments: [
        parseWireUri(monacoNs, uri),
        { lineNumber: position.line + 1, column: position.character + 1 },
        locations.map((l) => locationToMonaco(l, monacoNs)),
      ],
    }
  }
  return command.arguments ? { ...base, arguments: [...command.arguments] } : base
}

function codeLensToMonaco(lens: CodeLens, monacoNs: typeof monaco): MonacoCodeLens {
  return {
    range: rangeToMonaco(lens.range),
    ...(lens.command ? { command: commandToMonaco(lens.command, monacoNs) } : {}),
    _lspLens: lens,
  }
}

export function codeLensesToMonaco(
  lenses: CodeLens[] | null,
  monacoNs: typeof monaco,
): monaco.languages.CodeLensList {
  if (!lenses) return { lenses: [], dispose: () => undefined }
  return { lenses: lenses.map((l) => codeLensToMonaco(l, monacoNs)), dispose: () => undefined }
}

/** Fold a resolved LSP lens's `command` onto the Monaco lens Monaco passes to
 *  `resolveCodeLens` (the range is unchanged; only the command was lazy). */
export function resolvedCodeLensToMonaco(
  resolved: CodeLens | null,
  original: monaco.languages.CodeLens,
  monacoNs: typeof monaco,
): monaco.languages.CodeLens {
  if (!resolved?.command) return original
  return { ...original, command: commandToMonaco(resolved.command, monacoNs) }
}

/** LSP InlayHintLabelPart (field `value`) → Monaco InlayHintLabelPart (field `label`). */
function inlayHintLabelPartToMonaco(
  part: InlayHintLabelPart,
  monacoNs: typeof monaco,
): monaco.languages.InlayHintLabelPart {
  const tooltip = documentationToMonaco(part.tooltip)
  return {
    label: part.value,
    ...(tooltip !== undefined ? { tooltip } : {}),
    ...(part.location ? { location: locationToMonaco(part.location, monacoNs) } : {}),
    ...(part.command ? { command: commandToMonaco(part.command, monacoNs) } : {}),
  }
}

/**
 * A Monaco inlay hint carrying its host-side resolve coordinates, so
 * `resolveInlayHint` can address the original hint object (with its `data`)
 * in the extension host's cache (mirrors MonacoCodeLens).
 */
export interface MonacoInlayHint extends monaco.languages.InlayHint {
  _resolveCacheId?: number
  _resolveIndex?: number
}

function inlayHintToMonaco(hint: IInlayHintDto, monacoNs: typeof monaco): MonacoInlayHint {
  const tooltip = documentationToMonaco(hint.tooltip)
  return {
    position: { lineNumber: hint.position.line + 1, column: hint.position.character + 1 },
    label: Array.isArray(hint.label)
      ? hint.label.map((p) => inlayHintLabelPartToMonaco(p, monacoNs))
      : hint.label,
    ...(hint.kind !== undefined ? { kind: hint.kind as monaco.languages.InlayHintKind } : {}),
    ...(tooltip !== undefined ? { tooltip } : {}),
    ...(hint.textEdits ? { textEdits: hint.textEdits.map(textEditToMonaco) } : {}),
    ...(hint.paddingLeft !== undefined ? { paddingLeft: hint.paddingLeft } : {}),
    ...(hint.paddingRight !== undefined ? { paddingRight: hint.paddingRight } : {}),
    ...(hint.resolveCacheId !== undefined ? { _resolveCacheId: hint.resolveCacheId } : {}),
    ...(hint.resolveIndex !== undefined ? { _resolveIndex: hint.resolveIndex } : {}),
  }
}

/**
 * LSP InlayHint[] → Monaco InlayHintList. Kinds share the LSP/Monaco numeric
 * values (1 = Type, 2 = Parameter), so the kind passes through with a cast. The
 * LSP `data` field never crosses the wire — the host keeps the original hints
 * and the DTOs carry resolve coordinates (`resolveCacheId`/`resolveIndex`) when
 * the provider supports lazy resolve.
 */
export function inlayHintsToMonaco(
  hints: IInlayHintDto[] | null,
  monacoNs: typeof monaco,
): monaco.languages.InlayHintList {
  if (!hints) return { hints: [], dispose: () => undefined }
  return {
    hints: hints.map((h) => inlayHintToMonaco(h, monacoNs)),
    dispose: () => undefined,
  }
}

/** Fold a resolved inlay-hint DTO onto the Monaco hint Monaco passes to
 *  `resolveInlayHint`, re-running the full conversion (label parts, tooltip,
 *  textEdits…). Falls back to the original hint when the host's cache entry is
 *  gone (a newer provide round superseded it). */
export function resolvedInlayHintToMonaco(
  resolved: IInlayHintDto | null,
  original: monaco.languages.InlayHint,
  monacoNs: typeof monaco,
): monaco.languages.InlayHint {
  if (!resolved) return original
  return { ...inlayHintToMonaco(resolved, monacoNs) }
}
