/*---------------------------------------------------------------------------------------------
 *  Tests for the TS/JS LSP ↔ Monaco converters. Coordinate crossings (0-based LSP
 *  ↔ 1-based Monaco), enum remaps (SymbolKind, CompletionItemKind,
 *  DiagnosticSeverity) and the completion / workspace-edit shaping all live here.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { monaco } from '../../../../workbench/editor/monaco/MonacoLoader.js'
import type {
  CompletionItem,
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  SignatureHelp,
  WorkspaceEdit,
} from 'vscode-languageserver-types'
import {
  completionItemToMonaco,
  definitionToMonaco,
  diagnosticToMarker,
  documentSymbolsToMonaco,
  hoverToMonaco,
  monacoPositionToLsp,
  rangeToMonaco,
  signatureHelpToMonaco,
  workspaceEditToMonaco,
  workspaceSymbolsToEntries,
} from '../lspMonacoConvert.js'

const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
})

/** Minimal monaco namespace stand-in for converters that need one. */
const fakeMonaco = {
  Uri: { parse: (s: string) => ({ toString: () => s }) },
  MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
  MarkerTag: { Unnecessary: 1, Deprecated: 2 },
  languages: {
    CompletionItemKind: {
      Text: 18,
      Method: 0,
      Function: 1,
      Field: 3,
      Variable: 4,
      Class: 5,
      Property: 9,
      Snippet: 27,
    },
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
  },
} as unknown as typeof monaco

describe('rangeToMonaco', () => {
  it('shifts 0-based LSP coordinates to 1-based Monaco', () => {
    expect(rangeToMonaco(range(0, 0, 2, 5))).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: 6,
    })
  })
})

describe('monacoPositionToLsp', () => {
  it('shifts 1-based Monaco position to 0-based LSP', () => {
    expect(monacoPositionToLsp({ lineNumber: 3, column: 7 })).toEqual({ line: 2, character: 6 })
  })
})

describe('documentSymbolsToMonaco', () => {
  it('maps hierarchical symbols, kind offset and children recursively', () => {
    const input: DocumentSymbol = {
      name: 'A',
      kind: 5, // LSP Class
      range: range(0, 0, 4, 0),
      selectionRange: range(0, 0, 0, 1),
      children: [
        { name: 'm', kind: 6, range: range(2, 0, 3, 0), selectionRange: range(2, 0, 2, 1) },
      ],
    }
    const out = documentSymbolsToMonaco([input])
    expect(out[0]?.kind).toBe(4) // 5 → 4
    expect(out[0]?.range.startLineNumber).toBe(1)
    expect(out[0]?.children?.[0]?.name).toBe('m')
    expect(out[0]?.children?.[0]?.range.startLineNumber).toBe(3)
  })

  it('converts flat SymbolInformation (location doubles as both ranges)', () => {
    const out = documentSymbolsToMonaco([
      { name: 'f', kind: 12, location: { uri: 'file:///a.ts', range: range(1, 0, 1, 4) } },
    ])
    expect(out[0]?.name).toBe('f')
    expect(out[0]?.range).toEqual(out[0]?.selectionRange)
    expect(out[0]?.range.startLineNumber).toBe(2)
  })

  it('returns empty for null', () => {
    expect(documentSymbolsToMonaco(null)).toEqual([])
  })
})

describe('definitionToMonaco', () => {
  it('wraps a single Location into an array', () => {
    const loc: Location = { uri: 'file:///a.ts', range: range(4, 0, 4, 6) }
    const out = definitionToMonaco(loc, fakeMonaco) as monaco.languages.Location[]
    expect(out).toHaveLength(1)
    expect(out[0]?.uri.toString()).toBe('file:///a.ts')
    expect(out[0]?.range.startLineNumber).toBe(5)
  })

  it('maps LocationLink with target/selection ranges', () => {
    const out = definitionToMonaco(
      [
        {
          targetUri: 'file:///b.ts',
          targetRange: range(1, 0, 5, 0),
          targetSelectionRange: range(1, 2, 1, 8),
          originSelectionRange: range(0, 0, 0, 3),
        },
      ],
      fakeMonaco,
    ) as monaco.languages.LocationLink[]
    expect(out[0]?.uri.toString()).toBe('file:///b.ts')
    expect(out[0]?.targetSelectionRange?.startColumn).toBe(3)
    expect(out[0]?.originSelectionRange?.startLineNumber).toBe(1)
  })

  it('returns empty for null', () => {
    expect(definitionToMonaco(null, fakeMonaco)).toEqual([])
  })
})

describe('hoverToMonaco', () => {
  it('renders MarkupContent value directly', () => {
    const h: Hover = { contents: { kind: 'markdown', value: '**doc**' }, range: range(1, 0, 1, 4) }
    const out = hoverToMonaco(h)
    expect(out?.contents[0]?.value).toBe('**doc**')
    expect(out?.range?.startLineNumber).toBe(2)
  })

  it('wraps a language-tagged MarkedString into a fenced code block', () => {
    const h: Hover = { contents: { language: 'typescript', value: 'const x = 1' } }
    const out = hoverToMonaco(h)
    expect(out?.contents[0]?.value).toBe('```typescript\nconst x = 1\n```')
  })

  it('flattens an array of MarkedStrings', () => {
    const h: Hover = { contents: ['a', { language: 'ts', value: 'b' }] }
    const out = hoverToMonaco(h)
    expect(out?.contents).toHaveLength(2)
  })

  it('returns null for null', () => {
    expect(hoverToMonaco(null)).toBeNull()
  })
})

describe('completionItemToMonaco', () => {
  const defaultRange: monaco.IRange = {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 1,
  }

  it('maps kind via the explicit table and carries the source item', () => {
    const item: CompletionItem = { label: 'foo', kind: 6 } // LSP Variable
    const out = completionItemToMonaco(item, defaultRange, fakeMonaco)
    expect(out.kind).toBe(fakeMonaco.languages.CompletionItemKind.Variable)
    expect(out._lspItem).toBe(item)
    expect(out.insertText).toBe('foo')
    expect(out.range).toBe(defaultRange)
  })

  it('uses a textEdit range and newText when present', () => {
    const item: CompletionItem = {
      label: 'bar',
      textEdit: { range: range(2, 1, 2, 4), newText: 'barbar' },
    }
    const out = completionItemToMonaco(item, defaultRange, fakeMonaco)
    expect(out.insertText).toBe('barbar')
    expect((out.range as monaco.IRange).startLineNumber).toBe(3)
  })

  it('marks snippet items with InsertAsSnippet', () => {
    const item: CompletionItem = { label: 's', insertTextFormat: 2, insertText: 'a$1b' }
    const out = completionItemToMonaco(item, defaultRange, fakeMonaco)
    expect(out.insertTextRules).toBe(
      fakeMonaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
    )
  })

  it('splits InsertReplaceEdit into insert/replace ranges', () => {
    const item: CompletionItem = {
      label: 'ir',
      textEdit: { newText: 'ir', insert: range(0, 0, 0, 2), replace: range(0, 0, 0, 5) },
    }
    const out = completionItemToMonaco(item, defaultRange, fakeMonaco)
    const r = out.range as { insert: monaco.IRange; replace: monaco.IRange }
    expect(r.insert.endColumn).toBe(3)
    expect(r.replace.endColumn).toBe(6)
  })
})

describe('signatureHelpToMonaco', () => {
  it('maps signatures, parameters and active indices', () => {
    const help: SignatureHelp = {
      signatures: [
        {
          label: 'f(a: number): void',
          parameters: [{ label: 'a: number' }],
          activeParameter: 0,
        },
      ],
      activeSignature: 0,
      activeParameter: 0,
    }
    const out = signatureHelpToMonaco(help)
    expect(out?.value.signatures[0]?.label).toBe('f(a: number): void')
    expect(out?.value.signatures[0]?.parameters[0]?.label).toBe('a: number')
    expect(out?.value.activeSignature).toBe(0)
  })

  it('returns null for null', () => {
    expect(signatureHelpToMonaco(null)).toBeNull()
  })
})

describe('diagnosticToMarker', () => {
  const make = (severity: number): Diagnostic => ({
    range: range(1, 2, 1, 8),
    message: 'type error',
    severity: severity as 1 | 2 | 3 | 4,
  })

  it('maps LSP severity to Monaco MarkerSeverity', () => {
    expect(diagnosticToMarker(make(1), fakeMonaco).severity).toBe(8) // Error
    expect(diagnosticToMarker(make(2), fakeMonaco).severity).toBe(4) // Warning
    expect(diagnosticToMarker(make(3), fakeMonaco).severity).toBe(2) // Info
    expect(diagnosticToMarker(make(4), fakeMonaco).severity).toBe(1) // Hint
  })

  it('converts range to 1-based and carries message', () => {
    const m = diagnosticToMarker(make(2), fakeMonaco)
    expect(m.message).toBe('type error')
    expect(m.startLineNumber).toBe(2)
    expect(m.startColumn).toBe(3)
    expect(m.endColumn).toBe(9)
  })

  it('maps tags Unnecessary/Deprecated', () => {
    const m = diagnosticToMarker({ ...make(2), tags: [1, 2] }, fakeMonaco)
    expect(m.tags).toEqual([fakeMonaco.MarkerTag.Unnecessary, fakeMonaco.MarkerTag.Deprecated])
  })

  it('stringifies code when present', () => {
    const m = diagnosticToMarker({ ...make(1), code: 2304 }, fakeMonaco)
    expect(m.code).toBe('2304')
  })
})

describe('workspaceEditToMonaco', () => {
  it('flattens documentChanges with version ids', () => {
    const edit: WorkspaceEdit = {
      documentChanges: [
        {
          textDocument: { uri: 'file:///a.ts', version: 7 },
          edits: [{ range: range(0, 0, 0, 3), newText: 'NEW' }],
        },
      ],
    }
    const out = workspaceEditToMonaco(edit, fakeMonaco)
    expect(out.edits).toHaveLength(1)
    const e = out.edits[0] as monaco.languages.IWorkspaceTextEdit
    expect(e.resource.toString()).toBe('file:///a.ts')
    expect(e.textEdit.text).toBe('NEW')
    expect(e.versionId).toBe(7)
  })

  it('flattens the legacy changes map', () => {
    const edit: WorkspaceEdit = {
      changes: { 'file:///b.ts': [{ range: range(1, 0, 1, 2), newText: 'X' }] },
    }
    const out = workspaceEditToMonaco(edit, fakeMonaco)
    expect(out.edits).toHaveLength(1)
    const e = out.edits[0] as monaco.languages.IWorkspaceTextEdit
    expect(e.resource.toString()).toBe('file:///b.ts')
  })

  it('returns empty for null', () => {
    expect(workspaceEditToMonaco(null, fakeMonaco).edits).toEqual([])
  })
})

describe('workspaceSymbolsToEntries', () => {
  it('flattens symbols with container name and kind offset', () => {
    const out = workspaceSymbolsToEntries(
      [
        {
          name: 'Foo',
          kind: 5, // LSP Class
          containerName: 'mod',
          location: { uri: 'file:///a.ts', range: range(2, 0, 2, 3) },
        },
      ],
      fakeMonaco,
    )
    expect(out[0]?.name).toBe('Foo')
    expect(out[0]?.kind).toBe(4)
    expect(out[0]?.containerName).toBe('mod')
    expect(out[0]?.range.startLineNumber).toBe(3)
  })

  it('falls back to a 1,1 range for location stubs without a range', () => {
    const out = workspaceSymbolsToEntries(
      [{ name: 'Bar', kind: 5, location: { uri: 'file:///b.ts' } }],
      fakeMonaco,
    )
    expect(out[0]?.range.startLineNumber).toBe(1)
  })
})
