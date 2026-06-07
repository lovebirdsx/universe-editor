/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure converters between the language server's wire DTOs (0-based, LSP-shaped)
 *  and Monaco's types (1-based). No Monaco runtime dependency for ranges/symbols;
 *  location conversion takes the monaco namespace to build a Uri. Tested in
 *  isolation (lspMonacoConvert.test.ts).
 *--------------------------------------------------------------------------------------------*/

import { type monaco } from '../../../workbench/editor/monaco/MonacoLoader.js'
import type {
  MdDiagnostic,
  MdDocumentSymbol,
  MdLocation,
  MdPosition,
  MdRange,
} from '../../../../shared/ipc/markdownLanguageService.js'

/** LSP 0-based range → Monaco 1-based range. */
export function mdRangeToMonaco(r: MdRange): monaco.IRange {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  }
}

/** Monaco 1-based position → LSP 0-based position. */
export function monacoPositionToMd(p: monaco.IPosition): MdPosition {
  return { line: p.lineNumber - 1, character: p.column - 1 }
}

/**
 * LSP SymbolKind → Monaco SymbolKind. LSP numbers from 1 (File=1), Monaco from 0
 * (File=0), so the value is offset by one.
 */
function mdSymbolKindToMonaco(kind: number): monaco.languages.SymbolKind {
  return Math.max(0, kind - 1) as monaco.languages.SymbolKind
}

export function mdSymbolToMonaco(s: MdDocumentSymbol): monaco.languages.DocumentSymbol {
  return {
    name: s.name || '(empty)',
    detail: s.detail ?? '',
    kind: mdSymbolKindToMonaco(s.kind),
    tags: [],
    range: mdRangeToMonaco(s.range),
    selectionRange: mdRangeToMonaco(s.selectionRange),
    ...(s.children ? { children: s.children.map(mdSymbolToMonaco) } : {}),
  }
}

export function mdLocationToMonaco(
  l: MdLocation,
  monacoNs: typeof monaco,
): monaco.languages.Location {
  return { uri: monacoNs.Uri.parse(l.uri), range: mdRangeToMonaco(l.range) }
}

/**
 * LSP DiagnosticSeverity (1 Error / 2 Warning / 3 Information / 4 Hint) →
 * Monaco MarkerSeverity (8 Error / 4 Warning / 2 Info / 1 Hint). Takes the
 * monaco namespace because MarkerSeverity is a runtime enum value.
 */
export function mdDiagnosticToMarker(
  d: MdDiagnostic,
  monacoNs: typeof monaco,
): monaco.editor.IMarkerData {
  const S = monacoNs.MarkerSeverity
  const severity =
    d.severity === 1 ? S.Error : d.severity === 3 ? S.Info : d.severity === 4 ? S.Hint : S.Warning
  return {
    severity,
    message: d.message,
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
    ...(d.source ? { source: d.source } : {}),
    ...(d.code !== undefined ? { code: String(d.code) } : {}),
  }
}
