/*---------------------------------------------------------------------------------------------
 *  Tests for the LSP-DTO ↔ Monaco converters. The core of the bridge: every
 *  coordinate crossing (0-based LSP ↔ 1-based Monaco) and enum remap (SymbolKind,
 *  DiagnosticSeverity) lives here, so these assertions guard the whole feature.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { monaco } from '../../../../workbench/editor/monaco/MonacoLoader.js'
import type {
  MdDiagnostic,
  MdDocumentSymbol,
  MdLocation,
} from '../../../../../shared/ipc/markdownLanguageService.js'
import {
  mdDiagnosticToMarker,
  mdLocationToMonaco,
  mdRangeToMonaco,
  mdSymbolToMonaco,
  monacoPositionToMd,
} from '../lspMonacoConvert.js'

const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
})

/** Minimal monaco namespace stand-in for converters that need one. */
const fakeMonaco = {
  Uri: { parse: (s: string) => ({ toString: () => s }) },
  MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
} as unknown as typeof monaco

describe('mdRangeToMonaco', () => {
  it('shifts 0-based LSP coordinates to 1-based Monaco', () => {
    expect(mdRangeToMonaco(range(0, 0, 2, 5))).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: 6,
    })
  })
})

describe('monacoPositionToMd', () => {
  it('shifts 1-based Monaco position to 0-based LSP', () => {
    expect(monacoPositionToMd({ lineNumber: 3, column: 7 })).toEqual({ line: 2, character: 6 })
  })
})

describe('mdSymbolToMonaco', () => {
  it('maps kind (LSP n → monaco n-1), coordinates, and children recursively', () => {
    const input: MdDocumentSymbol = {
      name: 'A',
      kind: 15, // LSP String
      range: range(0, 0, 4, 0),
      selectionRange: range(0, 0, 0, 1),
      children: [
        { name: 'A.1', kind: 15, range: range(2, 0, 3, 0), selectionRange: range(2, 0, 2, 1) },
      ],
    }
    const out = mdSymbolToMonaco(input)
    expect(out.kind).toBe(14) // 15 → 14
    expect(out.range.startLineNumber).toBe(1)
    expect(out.children?.[0]?.name).toBe('A.1')
    expect(out.children?.[0]?.range.startLineNumber).toBe(3)
  })

  it('strips the leading markdown heading markup from the name', () => {
    const top = mdSymbolToMonaco({
      name: '# Heading',
      kind: 15,
      range: range(0, 0, 1, 0),
      selectionRange: range(0, 0, 0, 9),
      children: [
        { name: '## Sub', kind: 15, range: range(1, 0, 2, 0), selectionRange: range(1, 0, 1, 6) },
      ],
    })
    expect(top.name).toBe('Heading')
    expect(top.children?.[0]?.name).toBe('Sub')
  })

  it('substitutes a placeholder name for empty headings', () => {
    const out = mdSymbolToMonaco({
      name: '',
      kind: 15,
      range: range(0, 0, 0, 0),
      selectionRange: range(0, 0, 0, 0),
    })
    expect(out.name).toBe('(empty)')
  })
})

describe('mdLocationToMonaco', () => {
  it('parses the uri and converts the range', () => {
    const loc: MdLocation = { uri: 'file:///a.md', range: range(4, 0, 4, 6) }
    const out = mdLocationToMonaco(loc, fakeMonaco)
    expect(out.uri.toString()).toBe('file:///a.md')
    expect(out.range.startLineNumber).toBe(5)
  })
})

describe('mdDiagnosticToMarker', () => {
  const make = (severity: number): MdDiagnostic => ({
    range: range(1, 2, 1, 8),
    message: 'broken link',
    severity,
  })

  it('maps LSP severity to Monaco MarkerSeverity', () => {
    expect(mdDiagnosticToMarker(make(1), fakeMonaco).severity).toBe(8) // Error
    expect(mdDiagnosticToMarker(make(2), fakeMonaco).severity).toBe(4) // Warning
    expect(mdDiagnosticToMarker(make(3), fakeMonaco).severity).toBe(2) // Info
    expect(mdDiagnosticToMarker(make(4), fakeMonaco).severity).toBe(1) // Hint
  })

  it('converts the range to 1-based and carries the message', () => {
    const m = mdDiagnosticToMarker(make(2), fakeMonaco)
    expect(m.message).toBe('broken link')
    expect(m.startLineNumber).toBe(2)
    expect(m.startColumn).toBe(3)
    expect(m.endColumn).toBe(9)
  })

  it('includes source and stringified code when present', () => {
    const m = mdDiagnosticToMarker({ ...make(2), source: 'markdown', code: 42 }, fakeMonaco)
    expect(m.source).toBe('markdown')
    expect(m.code).toBe('42')
  })
})
