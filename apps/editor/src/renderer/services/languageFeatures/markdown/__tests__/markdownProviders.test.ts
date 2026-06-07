/*---------------------------------------------------------------------------------------------
 *  Tests for the markdown DocumentSymbol / Definition / Reference providers.
 *  All three are now thin shells over IMarkdownLanguageService; the tests assert
 *  the LSP→Monaco coordinate/kind mapping rather than any parsing logic.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import type { monaco } from '../../../../workbench/editor/monaco/MonacoLoader.js'

vi.mock('../../../../workbench/editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: {
    get: () => ({
      languages: { SymbolKind: { String: 14 } },
      Uri: { parse: (s: string) => ({ toString: () => s, __uri: s }) },
    }),
  },
}))

import { MarkdownDocumentSymbolProvider } from '../markdownDocumentSymbolProvider.js'
import { MarkdownDefinitionProvider } from '../markdownDefinitionProvider.js'
import { MarkdownReferenceProvider } from '../markdownReferenceProvider.js'
import type {
  IMarkdownLanguageService,
  MdLocation,
} from '../../../../../shared/ipc/markdownLanguageService.js'

function fakeModel(uri = 'file:///x.md'): monaco.editor.ITextModel {
  return { uri: { toString: () => uri } } as unknown as monaco.editor.ITextModel
}

const pos = (lineNumber: number, column: number): monaco.Position =>
  ({ lineNumber, column }) as monaco.Position

const range0 = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }

describe('MarkdownDocumentSymbolProvider', () => {
  it('maps server symbols to monaco symbols (LSP kind → monaco kind, 0→1-based)', async () => {
    const md = {
      provideDocumentSymbols: () =>
        Promise.resolve([
          {
            name: 'A',
            kind: 15, // LSP String
            range: range0,
            selectionRange: range0,
            children: [{ name: 'A.1', kind: 15, range: range0, selectionRange: range0 }],
          },
        ]),
    } as unknown as IMarkdownLanguageService

    const symbols = await new MarkdownDocumentSymbolProvider(md).provideDocumentSymbols(fakeModel())
    expect(symbols.map((s) => s.name)).toEqual(['A'])
    expect(symbols[0]?.children?.map((s) => s.name)).toEqual(['A.1'])
    expect(symbols[0]?.kind).toBe(14) // LSP 15 → monaco 14
    expect(symbols[0]?.range.startLineNumber).toBe(1) // 0-based → 1-based
  })
})

describe('MarkdownDefinitionProvider', () => {
  it('forwards the cursor position and maps server locations to monaco (0→1-based)', async () => {
    const calls: { uri: string; line: number; character: number }[] = []
    const location: MdLocation = {
      uri: 'file:///target.md',
      range: { start: { line: 4, character: 0 }, end: { line: 4, character: 6 } },
    }
    const md = {
      provideDefinition: (uri: { toString(): string }, p: { line: number; character: number }) => {
        calls.push({ uri: uri.toString(), line: p.line, character: p.character })
        return Promise.resolve([location])
      },
    } as unknown as IMarkdownLanguageService

    const defs = (await new MarkdownDefinitionProvider(md).provideDefinition(
      fakeModel('file:///src.md'),
      pos(3, 7),
    )) as monaco.languages.Location[]

    expect(calls).toEqual([{ uri: 'file:///src.md', line: 2, character: 6 }]) // 1→0-based
    expect(defs[0]?.uri.toString()).toBe('file:///target.md')
    expect(defs[0]?.range.startLineNumber).toBe(5) // 0→1-based
  })
})

describe('MarkdownReferenceProvider', () => {
  it('forwards includeDeclaration and maps every location', async () => {
    let includeDecl: boolean | undefined
    const md = {
      provideReferences: (
        _uri: unknown,
        _p: unknown,
        includeDeclaration: boolean,
      ): Promise<readonly MdLocation[]> => {
        includeDecl = includeDeclaration
        return Promise.resolve([
          { uri: 'file:///a.md', range: range0 },
          { uri: 'file:///b.md', range: range0 },
        ])
      },
    } as unknown as IMarkdownLanguageService

    const refs = await new MarkdownReferenceProvider(md).provideReferences(fakeModel(), pos(1, 1), {
      includeDeclaration: true,
    })

    expect(includeDecl).toBe(true)
    expect(refs.map((r) => r.uri.toString())).toEqual(['file:///a.md', 'file:///b.md'])
    expect(refs[0]?.range.startLineNumber).toBe(1)
  })
})
