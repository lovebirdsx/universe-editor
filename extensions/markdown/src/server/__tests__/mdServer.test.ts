/**
 * Integration test for the markdown server factory: drives the real
 * vscode-markdown-languageservice through an opened in-memory document (no
 * subprocess / stdio), with a stub filesystem client.
 */
import { describe, expect, it } from 'vitest'
import { URI } from 'vscode-uri'
import { createMdServer } from '../mdServer.js'
import type { IMdClient } from '../types.js'

const stubClient: IMdClient = {
  $readFile: () => Promise.resolve(undefined),
  $stat: () => Promise.resolve(undefined),
  $readDirectory: () => Promise.resolve([]),
  $findMarkdownFiles: () => Promise.resolve([]),
}

function newServer() {
  return createMdServer(stubClient, URI.file('/ws')).server
}

const URI_A = 'file:///ws/a.md'

describe('createMdServer — document symbols', () => {
  it('builds a nested heading tree from an opened document', async () => {
    const server = newServer()
    await server.$didOpen({ uri: URI_A, version: 1, text: '# A\n\n## A.1\n\n# B\n' })

    const symbols = await server.$provideDocumentSymbols(URI_A)
    // vscode-markdown-languageservice keeps the heading markup in the name.
    expect(symbols.map((s) => s.name)).toEqual(['# A', '# B'])
    expect(symbols[0]?.children?.map((s) => s.name)).toEqual(['## A.1'])
    // 0-based ranges on the wire.
    expect(symbols[0]?.range.start.line).toBe(0)
  })
})

describe('createMdServer — diagnostics', () => {
  it('flags a broken in-document fragment link', async () => {
    const server = newServer()
    await server.$didOpen({ uri: URI_A, version: 1, text: '# Real Heading\n\n[x](#missing)\n' })

    const diagnostics = await server.$computeDiagnostics(URI_A)
    expect(diagnostics.length).toBeGreaterThan(0)
    expect(diagnostics[0]?.severity).toBe(2) // LSP Warning
  })

  it('reports no diagnostics for a valid fragment link', async () => {
    const server = newServer()
    await server.$didOpen({
      uri: URI_A,
      version: 1,
      text: '# Real Heading\n\n[x](#real-heading)\n',
    })

    expect(await server.$computeDiagnostics(URI_A)).toEqual([])
  })
})

describe('createMdServer — workspace symbols', () => {
  it('finds headings across opened documents by query', async () => {
    const server = newServer()
    await server.$didOpen({ uri: URI_A, version: 1, text: '# Alpha\n\n## Beta\n' })

    const symbols = await server.$provideWorkspaceSymbols('Alpha')
    expect(symbols.some((s) => s.name === '# Alpha')).toBe(true)
  })
})
