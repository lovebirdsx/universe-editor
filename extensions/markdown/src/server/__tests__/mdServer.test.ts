/**
 * Integration test for the markdown server factory: drives the real
 * vscode-markdown-languageservice through an opened in-memory document (no
 * subprocess / stdio), with a stub filesystem client.
 */
import { describe, expect, it } from 'vitest'
import { URI } from 'vscode-uri'
import { createMdServer } from '../mdServer.js'
import { uriString } from '../uriString.js'
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

/** {@link memoryClient} plus a log of the keys `$readFile` was asked for. */
function recordingClient(files: Record<string, string>) {
  const base = memoryClient(files)
  const reads: string[] = []
  const client: IMdClient = {
    ...base,
    $readFile: (uri) => {
      reads.push(uri)
      return base.$readFile(uri)
    },
  }
  return { client, reads }
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
    // (`f:/ws/D:/workspace/vscode`), so it never matched what's on disk. The
    // stub reports the *real* drive path exists; a doc-dir-joined path would not.
    const stat = (uri: string) =>
      Promise.resolve(
        uri === 'file:///D:/workspace/vscode'
          ? ({ type: 'dir', mtime: 0, size: 0 } as const)
          : undefined,
      )
    const client: IMdClient = { ...stubClient, $stat: stat }
    const server = createMdServer(client, URI.file('/ws')).server
    await server.$didOpen({
      uri: URI_A,
      version: 1,
      text: '[vscode](D:/workspace/vscode)\n',
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
    const dirUri = URI.file('D:/workspace/vscode')
    const stat = (uri: string) =>
      Promise.resolve(
        uri === dirUri.toString() ? ({ type: 'dir', mtime: 0, size: 0 } as const) : undefined,
      )
    const client: IMdClient = { ...stubClient, $stat: stat }
    const server = createMdServer(client, URI.file('/ws')).server
    await server.$didOpen({ uri: URI_A, version: 1, text: '[vscode](D:/workspace/vscode)\n' })

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

  it('keeps the link relative when the paths carry a Windows drive letter', async () => {
    // Regression (Windows): the referrer used to reach the language service with a
    // lower-cased, `%3A`-encoded drive (vscode-uri's toString) while the rename
    // target kept its upper-case one, so the case-sensitive `path.posix.relative`
    // degraded the link into `../../../../E:/ws/c.md`.
    const client = memoryClient({
      'file:///E:/ws/a.md': '# A\n\n[link](./b.md)\n',
      'file:///E:/ws/c.md': '# C\n',
    })
    const server = createMdServer(client, URI.file('E:/ws')).server

    const edit = await server.$getRenameFileEdits([
      { oldUri: 'file:///E:/ws/b.md', newUri: 'file:///E:/ws/c.md' },
    ])

    expect(edit).not.toBeNull()
    // The service emits its own (vscode-uri) spelling for the edited document, so
    // match on identity rather than the byte form; the link text is the assertion.
    const change = edit?.documentChanges?.find(
      (c) =>
        'textDocument' in c && uriString(URI.parse(c.textDocument.uri)) === 'file:///E:/ws/a.md',
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

  it('recognizes an open document reported in the lower-cased editor spelling', async () => {
    const A = 'file:///E:/ws/a.md'
    const files: Record<string, string> = { [A]: '# A\n\n[x](#a)\n' }
    const { client, reads } = recordingClient(files)
    const server = createMdServer(client, URI.file('E:/ws')).server
    await server.$didOpen({ uri: A, version: 1, text: files[A]! })

    // The renderer hands back the editor's (vscode-uri) spelling of the same file;
    // missing the overlay would read it from disk and overwrite the language
    // service's cache for a document that is actually open.
    await server.$didChangeFiles(['file:///e%3A/ws/a.md'])

    expect(reads).toEqual([])
    expect(await server.$computeDiagnostics(A)).toEqual([])
  })
})

function headingNames(symbols: readonly { name?: unknown }[]): string[] {
  return symbols.map((s) => String(s.name))
}

describe('createMdServer — closed documents and the language-service cache', () => {
  // LS 按 URI 缓存 TOC，闭态重新读盘后不能继续返回关闭前的树。
  it('resets the heading cache with the fresh disk text after a close', async () => {
    const files: Record<string, string> = { [URI_A]: '# Old\n' }
    const server = createMdServer(memoryClient(files), URI.file('/ws')).server

    await server.$didOpen({ uri: URI_A, version: 1, text: files[URI_A]! })
    expect(headingNames(await server.$provideDocumentSymbols(URI_A))).toEqual(['# Old'])

    await server.$didClose(URI_A)
    files[URI_A] = '# New\n'

    expect(headingNames(await server.$provideDocumentSymbols(URI_A))).toEqual(['# New'])
  })

  // 重开必须使旧 TOC 失效，随后磁盘通知不能覆盖 overlay。
  it('applies a newer overlay when the document opens after a disk change', async () => {
    const files: Record<string, string> = { [URI_A]: '# Old\n' }
    const server = createMdServer(memoryClient(files), URI.file('/ws')).server

    await server.$didOpen({ uri: URI_A, version: 1, text: files[URI_A]! })
    expect(headingNames(await server.$provideDocumentSymbols(URI_A))).toEqual(['# Old'])
    await server.$didClose(URI_A)

    // 闭态磁盘通知先更新缓存，随后打开的 overlay 仍须覆盖它。
    files[URI_A] = '# Disk\n'
    await server.$didChangeFiles([URI_A])

    await server.$didOpen({ uri: URI_A, version: 2, text: '# Overlay\n' })
    expect(headingNames(await server.$provideDocumentSymbols(URI_A))).toEqual(['# Overlay'])
  })

  it('invalidates the old heading cache when reopening at the same version', async () => {
    const files: Record<string, string> = { [URI_A]: '# Old\n' }
    const { client, reads } = recordingClient(files)
    const server = createMdServer(client, URI.file('/ws')).server

    await server.$didOpen({ uri: URI_A, version: 1, text: files[URI_A]! })
    await server.$provideDocumentSymbols(URI_A)
    await server.$didClose(URI_A)

    await server.$didOpen({ uri: URI_A, version: 1, text: '# Overlay\n' })
    files[URI_A] = '# Disk\n'
    await server.$didChangeFiles([URI_A])

    expect(reads).toEqual([])
    expect(headingNames(await server.$provideDocumentSymbols(URI_A))).toEqual(['# Overlay'])
  })

  it('prefers an overlay that opens while a closed document is being read', async () => {
    const files: Record<string, string> = { [URI_A]: '# Old\n' }
    const base = memoryClient(files)
    let resolveRead!: (text: string) => void
    const client: IMdClient = {
      ...base,
      $readFile: (uri) =>
        uri === URI_A
          ? new Promise<string>((resolve) => (resolveRead = resolve))
          : base.$readFile(uri),
    }
    const server = createMdServer(client, URI.file('/ws')).server

    // 首次拉取尚无缓存，在磁盘返回前打开 overlay。
    const pending = server.$provideDocumentSymbols(URI_A)
    expect(resolveRead).toBeDefined()

    await server.$didOpen({ uri: URI_A, version: 1, text: '# Overlay\n' })
    resolveRead('# Disk\n')

    expect(headingNames(await pending)).toEqual(['# Overlay'])
  })

  it('prefers an overlay opened during a linked document read inside the language service', async () => {
    const target = 'file:///ws/target.md'
    const base = memoryClient({ [URI_A]: '# Source\n', [target]: '# Disk\n' })
    let resolveRead!: (text: string) => void
    let markReading!: () => void
    const reading = new Promise<void>((resolve) => (markReading = resolve))
    const client: IMdClient = {
      ...base,
      $readFile: (uri) => {
        if (uri !== target) return base.$readFile(uri)
        return new Promise<string>((resolve) => {
          resolveRead = resolve
          markReading()
        })
      },
    }
    const server = createMdServer(client, URI.file('/ws')).server
    await server.$didOpen({
      uri: URI_A,
      version: 1,
      text: '# Source\n\n[target](./target.md#overlay)\n',
    })

    // 链接诊断从 LS 内部读目标文件，不经过 mdServer.resolveDoc。
    const pending = server.$computeDiagnostics(URI_A)
    await reading
    await server.$didOpen({ uri: target, version: 1, text: '# Overlay\n' })
    resolveRead('# Disk\n')

    expect(await pending).toEqual([])
    expect(headingNames(await server.$provideDocumentSymbols(target))).toEqual(['# Overlay'])
  })

  it('does not overwrite an overlay opened during a $didChangeFiles disk read', async () => {
    const files: Record<string, string> = { [URI_A]: '# Old\n' }
    const base = memoryClient(files)
    let resolveRead!: (text: string) => void
    let deferred = false
    const client: IMdClient = {
      ...base,
      $readFile: (uri) =>
        uri === URI_A && deferred
          ? new Promise<string>((resolve) => (resolveRead = resolve))
          : base.$readFile(uri),
    }
    const server = createMdServer(client, URI.file('/ws')).server

    await server.$didOpen({ uri: URI_A, version: 1, text: files[URI_A]! })
    expect(headingNames(await server.$provideDocumentSymbols(URI_A))).toEqual(['# Old'])
    await server.$didClose(URI_A)

    files[URI_A] = '# Disk\n'
    deferred = true
    const notifying = server.$didChangeFiles([URI_A])
    expect(resolveRead).toBeDefined()

    // 文件在磁盘通知尚未读完时打开。
    await server.$didOpen({ uri: URI_A, version: 2, text: '# Overlay\n' })
    resolveRead('# Disk\n')
    await notifying

    expect(headingNames(await server.$provideDocumentSymbols(URI_A))).toEqual(['# Overlay'])
  })
})
