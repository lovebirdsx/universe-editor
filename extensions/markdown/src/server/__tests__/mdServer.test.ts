/**
 * Integration test for the markdown server factory: drives the real
 * vscode-markdown-languageservice through an opened in-memory document (no
 * subprocess / stdio), with a stub filesystem client.
 */
import { describe, expect, it } from 'vitest'
import { URI } from 'vscode-uri'
import { createMdServer } from '../mdServer.js'
import type { IMdClient, MdFileStat } from '../types.js'

const stubClient: IMdClient = {
  $readFile: () => Promise.resolve(undefined),
  $stat: () => Promise.resolve(undefined),
  $readDirectory: () => Promise.resolve([]),
  $findMarkdownFiles: () => Promise.resolve([]),
}

/** In-memory filesystem client, keyed by URI string. */
function memoryClient(files: Record<string, string>): IMdClient {
  const fileStat: MdFileStat = { type: 'file', mtime: 0, size: 0 }
  return {
    $readFile: (uri) => Promise.resolve(files[uri]),
    $stat: (uri) => Promise.resolve(uri in files ? fileStat : undefined),
    $readDirectory: () => Promise.resolve([]),
    $findMarkdownFiles: () => Promise.resolve(Object.keys(files).filter((u) => u.endsWith('.md'))),
  }
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

  it('does not flag bracket text inside YAML frontmatter, but still flags the body', async () => {
    const server = newServer()
    await server.$didOpen({
      uri: URI_A,
      version: 1,
      // `[hello]` in the preamble is YAML, not a reference link; `[missing]` in
      // the body is a genuine broken reference link.
      text: '---\ntitle: t\ndescription: [hello]\n---\n\n[missing][]\n',
    })

    const diagnostics = await server.$computeDiagnostics(URI_A)
    // No diagnostic may land inside the frontmatter block (lines 0..3).
    expect(diagnostics.every((d) => d.range.start.line > 3)).toBe(true)
    expect(diagnostics.length).toBeGreaterThan(0)
  })

  it('resolves a Windows drive-absolute link against the drive, not the doc dir', async () => {
    // Regression for the patched resolveInternalDocumentLink: `D:/…` used to fall
    // into the relative branch and get joined onto the document's directory
    // (`f:/ws/D:/git_project/vscode`), so it never matched what's on disk. The
    // stub reports the *real* drive path exists; a doc-dir-joined path would not.
    const stat = (uri: string) =>
      Promise.resolve(
        uri === URI.file('D:/git_project/vscode').toString()
          ? ({ type: 'dir', mtime: 0, size: 0 } as const)
          : undefined,
      )
    const client: IMdClient = { ...stubClient, $stat: stat }
    const server = createMdServer(client, URI.file('/ws')).server
    await server.$didOpen({
      uri: URI_A,
      version: 1,
      text: '[vscode](D:/git_project/vscode)\n',
    })

    const diagnostics = await server.$computeDiagnostics(URI_A)
    expect(diagnostics.filter((d) => d.code === 'link.no-such-file')).toEqual([])
  })

  it('flags a drive-absolute link whose target does not exist', async () => {
    const server = newServer() // stub $stat always returns undefined (missing)
    await server.$didOpen({
      uri: URI_A,
      version: 1,
      text: '[x](D:/nope/missing.md)\n',
    })

    const diagnostics = await server.$computeDiagnostics(URI_A)
    const noSuchFile = diagnostics.filter((d) => d.code === 'link.no-such-file')
    expect(noSuchFile.length).toBe(1)
    // The reported path must be the drive path itself, not one joined to the doc
    // dir (`/ws/D:/…`). URI.file lowercases the drive letter, so match loosely.
    const message = String(noSuchFile[0]?.message)
    expect(message.toLowerCase()).toContain('d:')
    expect(message).not.toContain('ws')
  })
})

describe('createMdServer — document links', () => {
  it('rewrites a folder link from a revealInExplorer command to a plain file URI', async () => {
    // The language service resolves a directory link to
    // `command:revealInExplorer?<uri>`; we don't register that command, so the
    // server must hand back a `file:` URI for Monaco's editor opener to follow.
    const dirUri = URI.file('D:/git_project/vscode')
    const stat = (uri: string) =>
      Promise.resolve(
        uri === dirUri.toString() ? ({ type: 'dir', mtime: 0, size: 0 } as const) : undefined,
      )
    const client: IMdClient = { ...stubClient, $stat: stat }
    const server = createMdServer(client, URI.file('/ws')).server
    await server.$didOpen({ uri: URI_A, version: 1, text: '[vscode](D:/git_project/vscode)\n' })

    const links = await server.$provideDocumentLinks(URI_A)
    expect(links.length).toBe(1)
    const resolved = await server.$resolveDocumentLink(links[0]!)
    expect(resolved?.target).toBe(dirUri.toString(true))
    expect(resolved?.target?.startsWith('command:')).toBe(false)
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

describe('createMdServer — rename file edits', () => {
  it('rewrites a link in another file that points at the renamed file', async () => {
    // Post-rename disk state: b.md was renamed to c.md; a.md still links to b.md.
    const client = memoryClient({
      'file:///ws/a.md': '# A\n\n[link](./b.md)\n',
      'file:///ws/c.md': '# C\n',
    })
    const server = createMdServer(client, URI.file('/ws')).server

    const edit = await server.$getRenameFileEdits([
      { oldUri: 'file:///ws/b.md', newUri: 'file:///ws/c.md' },
    ])

    expect(edit).not.toBeNull()
    const change = edit?.documentChanges?.find(
      (c) => 'textDocument' in c && c.textDocument.uri === 'file:///ws/a.md',
    )
    const edits = change && 'edits' in change ? change.edits : undefined
    expect(edits?.length).toBe(1)
    const first = edits?.[0]
    expect(first && 'newText' in first ? first.newText : undefined).toBe('./c.md')
  })

  it('returns null when no link needs updating', async () => {
    const client = memoryClient({
      'file:///ws/a.md': '# A\n\nno links here\n',
      'file:///ws/c.md': '# C\n',
    })
    const server = createMdServer(client, URI.file('/ws')).server

    const edit = await server.$getRenameFileEdits([
      { oldUri: 'file:///ws/b.md', newUri: 'file:///ws/c.md' },
    ])
    // No participating links → empty/undefined edit.
    const hasChanges =
      edit != null &&
      ((edit.changes && Object.keys(edit.changes).length > 0) ||
        (edit.documentChanges?.length ?? 0) > 0)
    expect(hasChanges).toBe(false)
  })

  it('returns null for an empty rename list', async () => {
    const server = newServer()
    expect(await server.$getRenameFileEdits([])).toBeNull()
  })
})

describe('createMdServer — $didChangeFiles refreshes stale caches', () => {
  // Regression: A links to B; B is moved while A is closed; the bulk edit
  // rewrites A's link on disk. With no filesystem watcher the language service
  // kept A's pre-move link cached, so reopening A warned that B's OLD path was
  // missing. $didChangeFiles must invalidate those caches.
  it('clears the stale broken-link diagnostic after a closed file is rewritten on disk', async () => {
    const A = 'file:///ws/a.md'
    const Bold = 'file:///ws/b.md'
    const Bnew = 'file:///ws/sub/b.md'
    const files: Record<string, string> = {
      [A]: '# A\n\n[to b](./b.md)\n',
      [Bold]: '# B\n',
    }
    const server = createMdServer(memoryClient(files), URI.file('/ws')).server

    // A was open once (populates the per-document link cache with the old link),
    // then closed (does not invalidate that cache).
    await server.$didOpen({ uri: A, version: 1, text: files[A]! })
    expect(await server.$computeDiagnostics(A)).toEqual([])
    await server.$didClose(A)

    // B moves; the bulk edit rewrites A's link — both happen on disk while A is
    // closed, so no document-change event reaches the service.
    delete files[Bold]
    files[Bnew] = '# B\n'
    files[A] = '# A\n\n[to b](./sub/b.md)\n'
    await server.$didChangeFiles([A, Bold, Bnew])

    // Reopening A must not warn about the pre-move path.
    await server.$didOpen({ uri: A, version: 1, text: files[A]! })
    expect(await server.$computeDiagnostics(A)).toEqual([])
  })

  it('ignores files currently open in an editor (their overlay is authoritative)', async () => {
    const A = 'file:///ws/a.md'
    const files: Record<string, string> = { [A]: '# A\n\n[x](#a)\n' }
    const server = createMdServer(memoryClient(files), URI.file('/ws')).server

    await server.$didOpen({ uri: A, version: 1, text: files[A]! })
    // A stale disk read would break the fragment link; open overlay must win.
    files[A] = '# A\n\n[x](#missing)\n'
    await server.$didChangeFiles([A])
    expect(await server.$computeDiagnostics(A)).toEqual([])
  })
})
