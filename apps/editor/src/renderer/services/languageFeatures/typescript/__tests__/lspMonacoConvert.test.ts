/*---------------------------------------------------------------------------------------------
 *  Tests for the TS/JS LSP ↔ Monaco converters. Coordinate crossings (0-based LSP
 *  ↔ 1-based Monaco), enum remaps (SymbolKind, CompletionItemKind,
 *  DiagnosticSeverity) and the completion / workspace-edit shaping all live here.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { monaco } from '../../../../workbench/editor/monaco/MonacoLoader.js'
import type { IInlayHintDto } from '@universe-editor/extensions-common'
import type {
  CodeAction,
  CodeLens,
  CompletionItem,
  Diagnostic,
  DocumentHighlight,
  DocumentLink,
  DocumentSymbol,
  Hover,
  InlayHint,
  Location,
  SelectionRange,
  SignatureHelp,
  WorkspaceEdit,
} from 'vscode-languageserver-types'
import {
  codeActionsToMonaco,
  codeLensesToMonaco,
  completionItemToMonaco,
  definitionToMonaco,
  diagnosticToMarker,
  documentHighlightsToMonaco,
  documentLinksToMonaco,
  documentSymbolsToMonaco,
  hoverToMonaco,
  inlayHintsToMonaco,
  markerToLspDiagnostic,
  monacoPositionToLsp,
  rangeToMonaco,
  resolvedCodeLensToMonaco,
  resolvedDocumentLinkToMonaco,
  resolvedInlayHintToMonaco,
  selectionRangesToMonaco,
  semanticTokensToMonaco,
  signatureHelpToMonaco,
  workspaceEditToMonaco,
  workspaceSymbolsToEntries,
  type MonacoInlayHint,
} from '../lspMonacoConvert.js'
import { setWireUriRemoteAuthority } from '../wireUri.js'

const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
})

/** Minimal monaco Uri stand-in: keeps the components so parseWireUri can rebuild
 *  them, and serializes back with the usual `//`-when-authority rule. */
const fakeUriFrom = (c: {
  scheme: string
  authority?: string
  path?: string
  query?: string
  fragment?: string
}) => {
  const parts = {
    scheme: c.scheme,
    authority: c.authority ?? '',
    path: c.path ?? '',
    query: c.query ?? '',
    fragment: c.fragment ?? '',
  }
  return {
    ...parts,
    toString: () =>
      parts.scheme +
      ':' +
      (parts.authority || parts.scheme === 'file' ? '//' : '') +
      parts.authority +
      parts.path +
      (parts.query ? '?' + parts.query : '') +
      (parts.fragment ? '#' + parts.fragment : ''),
  }
}

const fakeUriParse = (raw: string): ReturnType<typeof fakeUriFrom> => {
  const m = /^(([^:/?#]+):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?/.exec(raw)
  return fakeUriFrom({
    scheme: m?.[2] ?? '',
    authority: m?.[4] ?? '',
    path: m?.[5] ?? '',
    query: m?.[7] ?? '',
    fragment: m?.[9] ?? '',
  })
}

/** Minimal monaco namespace stand-in for converters that need one. */
const fakeMonaco = {
  Uri: { parse: fakeUriParse, from: fakeUriFrom },
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

// The wire URI remote authority is module ambient state; never leak it between tests.
afterEach(() => setWireUriRemoteAuthority(undefined))

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

describe('markerToLspDiagnostic', () => {
  const makeMarker = (
    severity: number,
    extra?: Partial<monaco.editor.IMarker>,
  ): monaco.editor.IMarker => ({
    severity,
    message: 'type error',
    startLineNumber: 3,
    startColumn: 2,
    endLineNumber: 3,
    endColumn: 9,
    resource: fakeMonaco.Uri.parse('file:///a.ts'),
    owner: 'ts',
    ...extra,
  })

  it('maps MarkerSeverity to LSP severity', () => {
    expect(markerToLspDiagnostic(makeMarker(8)).severity).toBe(1) // Error
    expect(markerToLspDiagnostic(makeMarker(4)).severity).toBe(2) // Warning
    expect(markerToLspDiagnostic(makeMarker(2)).severity).toBe(3) // Info
    expect(markerToLspDiagnostic(makeMarker(1)).severity).toBe(4) // Hint
  })

  it('falls back to Error for an unknown severity', () => {
    expect(markerToLspDiagnostic(makeMarker(16)).severity).toBe(1)
  })

  it('converts positions back to 0-based and carries the message', () => {
    const d = markerToLspDiagnostic(makeMarker(8))
    expect(d.message).toBe('type error')
    expect(d.range).toEqual(range(2, 1, 2, 8))
  })

  it('keeps the stringified code verbatim (VSCode parity), including numeric-looking codes', () => {
    expect(markerToLspDiagnostic(makeMarker(8, { code: '2304' })).code).toBe('2304')
    expect(markerToLspDiagnostic(makeMarker(8, { code: 'ts-missing' })).code).toBe('ts-missing')
    expect(markerToLspDiagnostic(makeMarker(8)).code).toBeUndefined()
  })

  it('preserves leading zeros in codes instead of numericising them', () => {
    expect(markerToLspDiagnostic(makeMarker(8, { code: '0123' })).code).toBe('0123')
  })

  it('round-trips a { value, target } code into code + codeDescription.href', () => {
    const d = markerToLspDiagnostic(
      makeMarker(8, {
        code: {
          value: '2304',
          target: fakeMonaco.Uri.parse('https://typescript.tv/errors/#2304') as never,
        },
      }),
    )
    expect(d.code).toBe('2304')
    expect(d.codeDescription).toEqual({ href: 'https://typescript.tv/errors/#2304' })
  })

  it('maps MarkerTag back to LSP DiagnosticTags and drops unknown tags', () => {
    const d = markerToLspDiagnostic(makeMarker(4, { tags: [1, 2, 4 as monaco.MarkerTag] }))
    expect(d.tags).toEqual([1, 2])
    expect(markerToLspDiagnostic(makeMarker(4)).tags).toBeUndefined()
  })

  it('carries source when present', () => {
    expect(markerToLspDiagnostic(makeMarker(2, { source: 'typescript' })).source).toBe('typescript')
    expect(markerToLspDiagnostic(makeMarker(2)).source).toBeUndefined()
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

  it('converts create/rename/delete documentChanges carrying their options', () => {
    const edit: WorkspaceEdit = {
      documentChanges: [
        { kind: 'create', uri: 'file:///new.ts', options: { overwrite: true } },
        {
          kind: 'rename',
          oldUri: 'file:///old.ts',
          newUri: 'file:///renamed.ts',
          options: { ignoreIfExists: true },
        },
        {
          kind: 'delete',
          uri: 'file:///gone.ts',
          options: { recursive: true, ignoreIfNotExists: true },
        },
      ],
    }
    const out = workspaceEditToMonaco(edit, fakeMonaco)
    expect(out.edits).toHaveLength(3)
    const [create, rename, del] = out.edits as monaco.languages.IWorkspaceFileEdit[]
    expect(create?.newResource?.toString()).toBe('file:///new.ts')
    expect(create?.oldResource).toBeUndefined()
    expect(create?.options).toEqual({ overwrite: true })
    expect(rename?.oldResource?.toString()).toBe('file:///old.ts')
    expect(rename?.newResource?.toString()).toBe('file:///renamed.ts')
    expect(rename?.options).toEqual({ ignoreIfExists: true })
    expect(del?.oldResource?.toString()).toBe('file:///gone.ts')
    expect(del?.options).toEqual({ recursive: true, ignoreIfNotExists: true })
  })

  it('preserves documentChanges order when text edits interleave file operations', () => {
    const edit: WorkspaceEdit = {
      documentChanges: [
        { kind: 'create', uri: 'file:///a.txt' },
        {
          textDocument: { uri: 'file:///a.txt', version: null },
          edits: [{ range: range(0, 0, 0, 0), newText: 'hi' }],
        },
        { kind: 'rename', oldUri: 'file:///a.txt', newUri: 'file:///b.txt' },
      ],
    }
    const out = workspaceEditToMonaco(edit, fakeMonaco)
    expect(out.edits).toHaveLength(3)
    expect('newResource' in out.edits[0]! && !('textEdit' in out.edits[0]!)).toBe(true)
    expect('textEdit' in out.edits[1]!).toBe(true)
    expect('oldResource' in out.edits[2]!).toBe(true)
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

describe('documentLinksToMonaco', () => {
  it('maps a link with a target onto a parsed Uri and keeps the LSP source', () => {
    const link: DocumentLink = { range: range(0, 0, 0, 4), target: 'file:///a.md' }
    const out = documentLinksToMonaco([link], fakeMonaco)
    expect(out.links).toHaveLength(1)
    expect(out.links[0]?.range.startLineNumber).toBe(1)
    expect(out.links[0]?.url?.toString()).toBe('file:///a.md')
    expect((out.links[0] as unknown as { _lspLink: DocumentLink })._lspLink).toBe(link)
  })

  it('leaves an unresolved link (no target) without a url', () => {
    const out = documentLinksToMonaco([{ range: range(0, 0, 0, 4) }], fakeMonaco)
    expect(out.links[0]?.url).toBeUndefined()
  })

  it('returns an empty list for null', () => {
    expect(documentLinksToMonaco(null, fakeMonaco)).toEqual({ links: [] })
  })
})

describe('resolvedDocumentLinkToMonaco', () => {
  it('maps the resolved target onto the original link url', () => {
    const original = { range: rangeToMonaco(range(0, 0, 0, 4)) } as monaco.languages.ILink
    const out = resolvedDocumentLinkToMonaco(
      { range: range(0, 0, 0, 4), target: 'file:///r.md' },
      original,
      fakeMonaco,
    )
    expect(out.url?.toString()).toBe('file:///r.md')
  })

  it('returns the original unchanged when nothing resolved', () => {
    const original = { range: rangeToMonaco(range(0, 0, 0, 4)) } as monaco.languages.ILink
    expect(resolvedDocumentLinkToMonaco(null, original, fakeMonaco)).toBe(original)
  })
})

describe('documentHighlightsToMonaco', () => {
  it('offsets the LSP 1/2/3 kind to Monaco 0/1/2', () => {
    const highlights: DocumentHighlight[] = [
      { range: range(0, 0, 0, 1), kind: 1 },
      { range: range(1, 0, 1, 1), kind: 3 },
    ]
    const out = documentHighlightsToMonaco(highlights)
    expect(out[0]?.kind).toBe(0)
    expect(out[1]?.kind).toBe(2)
    expect(out[0]?.range.startLineNumber).toBe(1)
  })

  it('omits kind when the LSP highlight has none', () => {
    const out = documentHighlightsToMonaco([{ range: range(0, 0, 0, 1) }])
    expect(out[0]?.kind).toBeUndefined()
  })
})

describe('selectionRangesToMonaco', () => {
  it('flattens each parent chain innermost-to-outermost', () => {
    const head: SelectionRange = {
      range: range(2, 2, 2, 4),
      parent: { range: range(2, 0, 2, 8), parent: { range: range(0, 0, 5, 0) } },
    }
    const out = selectionRangesToMonaco([head])
    expect(out).toHaveLength(1)
    expect(out[0]?.map((r) => r.range.startLineNumber)).toEqual([3, 3, 1])
  })
})

describe('codeActionsToMonaco', () => {
  it('converts edits + diagnostics and maps disabled reason', () => {
    const edit: WorkspaceEdit = {
      changes: { 'file:///a.md': [{ range: range(0, 0, 0, 1), newText: 'x' }] },
    }
    const diag: Diagnostic = { range: range(0, 0, 0, 1), message: 'm', severity: 1 }
    const actions: CodeAction[] = [
      { title: 'Fix', kind: 'quickfix', isPreferred: true, edit, diagnostics: [diag] },
      { title: 'Nope', disabled: { reason: 'unavailable' } },
    ]
    const out = codeActionsToMonaco(actions, fakeMonaco)
    expect(out.actions).toHaveLength(2)
    expect(out.actions[0]?.title).toBe('Fix')
    expect(out.actions[0]?.kind).toBe('quickfix')
    expect(out.actions[0]?.isPreferred).toBe(true)
    expect(out.actions[0]?.edit?.edits).toHaveLength(1)
    expect(out.actions[0]?.diagnostics).toHaveLength(1)
    expect(out.actions[1]?.disabled).toBe('unavailable')
  })

  it('returns an empty list for null', () => {
    expect(codeActionsToMonaco(null, fakeMonaco).actions).toEqual([])
  })
})

describe('semanticTokensToMonaco', () => {
  it('passes the delta-encoded token stream through as a Uint32Array', () => {
    const out = semanticTokensToMonaco({ data: [0, 5, 3, 9, 0, 1, 2, 4, 5, 0], resultId: 'r1' })
    expect(out?.data).toBeInstanceOf(Uint32Array)
    expect(Array.from(out?.data ?? [])).toEqual([0, 5, 3, 9, 0, 1, 2, 4, 5, 0])
    expect(out?.resultId).toBe('r1')
  })

  it('omits resultId when absent', () => {
    const out = semanticTokensToMonaco({ data: [0, 0, 1, 0, 0] })
    expect(out?.resultId).toBeUndefined()
    expect(Array.from(out?.data ?? [])).toEqual([0, 0, 1, 0, 0])
  })

  it('returns null for null', () => {
    expect(semanticTokensToMonaco(null)).toBeNull()
  })
})

describe('codeLensesToMonaco', () => {
  it('converts ranges and keeps the originating LSP lens for resolution', () => {
    const lens: CodeLens = { range: range(2, 0, 2, 5), data: { uri: 'file:///a.ts' } }
    const out = codeLensesToMonaco([lens], fakeMonaco)
    expect(out.lenses).toHaveLength(1)
    expect(out.lenses[0]?.range).toEqual(rangeToMonaco(lens.range))
    // Carries the raw lens (untyped on the public shape) so resolveCodeLens can
    // hand the exact server lens back.
    expect((out.lenses[0] as unknown as { _lspLens: CodeLens })._lspLens).toBe(lens)
    expect(out.lenses[0]?.command).toBeUndefined()
  })

  it('returns an empty, disposable list for null', () => {
    const out = codeLensesToMonaco(null, fakeMonaco)
    expect(out.lenses).toEqual([])
    expect(() => out.dispose?.()).not.toThrow()
  })
})

describe('resolvedCodeLensToMonaco', () => {
  it('translates a resolved showReferences command (uri/position/locations)', () => {
    const original = { range: rangeToMonaco(range(2, 0, 2, 5)) }
    const locations: Location[] = [{ uri: 'file:///b.ts', range: range(9, 1, 9, 4) }]
    const resolved: CodeLens = {
      range: range(2, 0, 2, 5),
      command: {
        title: '2 references',
        command: 'editor.action.showReferences',
        arguments: ['file:///a.ts', { line: 2, character: 0 }, locations],
      },
    }
    const out = resolvedCodeLensToMonaco(resolved, original, fakeMonaco)
    expect(out.command?.id).toBe('editor.action.showReferences')
    expect(out.command?.title).toBe('2 references')
    const [uri, position, locs] = out.command?.arguments as [
      { toString(): string },
      monaco.IPosition,
      monaco.languages.Location[],
    ]
    expect(uri.toString()).toBe('file:///a.ts')
    // LSP 0-based position → Monaco 1-based.
    expect(position).toEqual({ lineNumber: 3, column: 1 })
    expect(locs[0]?.range).toEqual(rangeToMonaco(range(9, 1, 9, 4)))
  })

  it('passes a non-showReferences command through with its arguments', () => {
    const original = { range: rangeToMonaco(range(0, 0, 0, 1)) }
    const resolved: CodeLens = {
      range: range(0, 0, 0, 1),
      command: { title: 'Run', command: 'ext.run', arguments: [{ id: 42 }] },
    }
    const out = resolvedCodeLensToMonaco(resolved, original, fakeMonaco)
    expect(out.command?.id).toBe('ext.run')
    expect(out.command?.arguments).toEqual([{ id: 42 }])
  })

  it('returns the original lens when nothing resolved', () => {
    const original = { range: rangeToMonaco(range(0, 0, 0, 1)) }
    expect(resolvedCodeLensToMonaco(null, original, fakeMonaco)).toBe(original)
    expect(resolvedCodeLensToMonaco({ range: range(0, 0, 0, 1) }, original, fakeMonaco)).toBe(
      original,
    )
  })
})

describe('inlayHintsToMonaco', () => {
  it('shifts positions, passes kind/padding through and carries resolve coordinates', () => {
    const hint: IInlayHintDto = {
      position: { line: 4, character: 9 },
      label: ': string',
      kind: 1, // LSP Type — same numeric value as Monaco's InlayHintKind.Type
      tooltip: { kind: 'markdown', value: 'the inferred type' },
      paddingLeft: true,
      textEdits: [{ range: range(4, 9, 4, 9), newText: ': string' }],
      resolveCacheId: 7,
      resolveIndex: 2,
    }
    const out = inlayHintsToMonaco([hint], fakeMonaco)
    expect(out.hints).toHaveLength(1)
    const converted = out.hints[0]!
    expect(converted.position).toEqual({ lineNumber: 5, column: 10 })
    expect(converted.label).toBe(': string')
    expect(converted.kind).toBe(1)
    expect(converted.tooltip).toEqual({ value: 'the inferred type' })
    expect(converted.paddingLeft).toBe(true)
    expect(converted.paddingRight).toBeUndefined()
    expect(converted.textEdits?.[0]).toEqual({
      range: rangeToMonaco(range(4, 9, 4, 9)),
      text: ': string',
    })
    // Resolve coordinates ride along for the lazy resolve round trip.
    const withCoords = converted as MonacoInlayHint
    expect(withCoords._resolveCacheId).toBe(7)
    expect(withCoords._resolveIndex).toBe(2)
    // `data` is stripped host-side and never appears on the wire DTO.
    expect('data' in converted).toBe(false)
  })

  it('maps label parts (value → label) with location and command', () => {
    const hint: InlayHint = {
      position: { line: 0, character: 0 },
      label: [
        {
          value: 'count',
          tooltip: 'parameter',
          location: { uri: 'file:///a.ts', range: range(1, 0, 1, 5) },
          command: { title: 'Go', command: 'ext.go', arguments: [1] },
        },
      ],
      kind: 2, // Parameter
    }
    const out = inlayHintsToMonaco([hint], fakeMonaco)
    const parts = out.hints[0]?.label
    expect(Array.isArray(parts)).toBe(true)
    const part = (parts as monaco.languages.InlayHintLabelPart[])[0]!
    expect(part.label).toBe('count')
    expect(part.tooltip).toBe('parameter')
    expect(part.location?.range).toEqual(rangeToMonaco(range(1, 0, 1, 5)))
    expect(part.command?.id).toBe('ext.go')
    expect(part.command?.arguments).toEqual([1])
  })

  it('returns an empty, disposable list for null', () => {
    const out = inlayHintsToMonaco(null, fakeMonaco)
    expect(out.hints).toEqual([])
    expect(() => out.dispose()).not.toThrow()
  })
})

describe('resolvedInlayHintToMonaco', () => {
  it('rebuilds the hint from the resolved DTO (lazy label/tooltip filled in)', () => {
    const original: monaco.languages.InlayHint = {
      position: { lineNumber: 5, column: 10 },
      label: ': string',
    }
    const resolved: IInlayHintDto = {
      position: { line: 4, character: 9 },
      label: ': string',
      tooltip: { kind: 'markdown', value: 'the inferred type' },
      paddingLeft: true,
    }
    const out = resolvedInlayHintToMonaco(resolved, original, fakeMonaco)
    expect(out.position).toEqual({ lineNumber: 5, column: 10 })
    expect(out.label).toBe(': string')
    expect(out.tooltip).toEqual({ value: 'the inferred type' })
    expect(out.paddingLeft).toBe(true)
    // A resolved hint carries no resolve coordinates (it would re-resolve).
    expect((out as MonacoInlayHint)._resolveCacheId).toBeUndefined()
  })

  it('returns the original hint when the host cache entry is gone', () => {
    const original: monaco.languages.InlayHint = {
      position: { lineNumber: 5, column: 10 },
      label: ': string',
    }
    expect(resolvedInlayHintToMonaco(null, original, fakeMonaco)).toBe(original)
  })
})

describe('wire URI translation with a remote authority', () => {
  beforeEach(() => setWireUriRemoteAuthority('wsl+ubuntu'))

  it('translates Location and LocationLink file URIs to remote-ssh', () => {
    const loc = definitionToMonaco(
      { uri: 'file:///home/x/a.ts', range: range(4, 0, 4, 6) },
      fakeMonaco,
    ) as monaco.languages.Location[]
    expect(loc[0]?.uri.toString()).toBe('remote-ssh://wsl+ubuntu/home/x/a.ts')

    const links = definitionToMonaco(
      [
        {
          targetUri: 'file:///home/x/b.ts',
          targetRange: range(1, 0, 5, 0),
          targetSelectionRange: range(1, 2, 1, 8),
        },
      ],
      fakeMonaco,
    ) as monaco.languages.LocationLink[]
    expect(links[0]?.uri.toString()).toBe('remote-ssh://wsl+ubuntu/home/x/b.ts')
  })

  it('translates showReferences command uri and locations arguments', () => {
    const lens: CodeLens = {
      range: range(2, 0, 2, 5),
      command: {
        title: '1 reference',
        command: 'editor.action.showReferences',
        arguments: [
          'file:///home/x/a.ts',
          { line: 2, character: 0 },
          [{ uri: 'file:///home/x/b.ts', range: range(9, 1, 9, 4) }],
        ],
      },
    }
    const out = codeLensesToMonaco([lens], fakeMonaco)
    const [uri, , locs] = out.lenses[0]?.command?.arguments as [
      { toString(): string },
      monaco.IPosition,
      monaco.languages.Location[],
    ]
    expect(uri.toString()).toBe('remote-ssh://wsl+ubuntu/home/x/a.ts')
    expect(locs[0]?.uri.toString()).toBe('remote-ssh://wsl+ubuntu/home/x/b.ts')
  })

  it('translates workspace edit changes-map keys and text-document edit URIs', () => {
    const mapped = workspaceEditToMonaco(
      { changes: { 'file:///home/x/a.ts': [{ range: range(0, 0, 0, 3), newText: 'X' }] } },
      fakeMonaco,
    )
    expect((mapped.edits[0] as monaco.languages.IWorkspaceTextEdit).resource.toString()).toBe(
      'remote-ssh://wsl+ubuntu/home/x/a.ts',
    )

    const docChanges = workspaceEditToMonaco(
      {
        documentChanges: [
          {
            textDocument: { uri: 'file:///home/x/doc.ts', version: 1 },
            edits: [{ range: range(0, 0, 0, 1), newText: 'y' }],
          },
        ],
      },
      fakeMonaco,
    )
    expect((docChanges.edits[0] as monaco.languages.IWorkspaceTextEdit).resource.toString()).toBe(
      'remote-ssh://wsl+ubuntu/home/x/doc.ts',
    )
  })

  it('translates create/rename/delete file operation URIs', () => {
    const out = workspaceEditToMonaco(
      {
        documentChanges: [
          { kind: 'create', uri: 'file:///home/x/created.ts' },
          {
            kind: 'rename',
            oldUri: 'file:///home/x/old.ts',
            newUri: 'file:///home/x/new.ts',
          },
          { kind: 'delete', uri: 'file:///home/x/gone.ts' },
        ],
      },
      fakeMonaco,
    )
    const [create, rename, del] = out.edits as monaco.languages.IWorkspaceFileEdit[]
    expect(create?.newResource?.toString()).toBe('remote-ssh://wsl+ubuntu/home/x/created.ts')
    expect(rename?.oldResource?.toString()).toBe('remote-ssh://wsl+ubuntu/home/x/old.ts')
    expect(rename?.newResource?.toString()).toBe('remote-ssh://wsl+ubuntu/home/x/new.ts')
    expect(del?.oldResource?.toString()).toBe('remote-ssh://wsl+ubuntu/home/x/gone.ts')
  })

  it('translates document link targets, provided and resolved', () => {
    const out = documentLinksToMonaco(
      [{ range: range(0, 0, 0, 4), target: 'file:///home/x/a.md' }],
      fakeMonaco,
    )
    expect(out.links[0]?.url?.toString()).toBe('remote-ssh://wsl+ubuntu/home/x/a.md')

    const resolved = resolvedDocumentLinkToMonaco(
      { range: range(0, 0, 0, 4), target: 'file:///home/x/r.md' },
      { range: rangeToMonaco(range(0, 0, 0, 4)) } as monaco.languages.ILink,
      fakeMonaco,
    )
    expect(resolved.url?.toString()).toBe('remote-ssh://wsl+ubuntu/home/x/r.md')
  })

  it('translates diagnostic codeDescription hrefs pointing at file URIs', () => {
    const m = diagnosticToMarker(
      {
        range: range(1, 2, 1, 8),
        message: 'm',
        severity: 2,
        code: 'rule',
        codeDescription: { href: 'file:///home/x/rules/rule.md' },
      },
      fakeMonaco,
    )
    const code = m.code as { value: string; target: monaco.Uri }
    expect(code.target.toString()).toBe('remote-ssh://wsl+ubuntu/home/x/rules/rule.md')
  })

  it('leaves non-file schemes untouched', () => {
    const untitled = definitionToMonaco(
      { uri: 'untitled:Untitled-1', range: range(0, 0, 0, 1) },
      fakeMonaco,
    ) as monaco.languages.Location[]
    expect(untitled[0]?.uri.toString()).toBe('untitled:Untitled-1')

    const https = definitionToMonaco(
      { uri: 'https://example.com/a.ts', range: range(0, 0, 0, 1) },
      fakeMonaco,
    ) as monaco.languages.Location[]
    expect(https[0]?.uri.toString()).toBe('https://example.com/a.ts')
  })
})

describe('wire URI translation without a remote authority', () => {
  it('parses file URIs as local file URIs', () => {
    const out = definitionToMonaco(
      { uri: 'file:///home/x/a.ts', range: range(0, 0, 0, 1) },
      fakeMonaco,
    ) as monaco.languages.Location[]
    expect(out[0]?.uri.toString()).toBe('file:///home/x/a.ts')
  })
})
