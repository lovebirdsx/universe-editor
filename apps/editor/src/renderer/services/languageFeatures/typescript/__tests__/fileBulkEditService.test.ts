import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FileSystemError, URI, type IFileService } from '@universe-editor/platform'
import {
  applyTextEditsToString,
  FileBulkEditService,
  stripSnippet,
} from '../fileBulkEditService.js'

vi.mock('../../../../workbench/editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: {
    get: () => ({ Range: { lift: (r: unknown) => r } }),
    peek: () => undefined,
    ensureInitialized: () => Promise.resolve({ Range: { lift: (r: unknown) => r } }),
  },
}))

const range = (sl: number, sc: number, el: number, ec: number) => ({
  startLineNumber: sl,
  startColumn: sc,
  endLineNumber: el,
  endColumn: ec,
})

describe('applyTextEditsToString', () => {
  it('replaces a single-line span', () => {
    expect(
      applyTextEditsToString('const foo = 1', [{ range: range(1, 7, 1, 10), text: 'bar' }]),
    ).toBe('const bar = 1')
  })

  it('applies multiple edits without offset drift (sorted bottom-up)', () => {
    const text = 'foo + foo'
    const edits = [
      { range: range(1, 1, 1, 4), text: 'bar' },
      { range: range(1, 7, 1, 10), text: 'bar' },
    ]
    expect(applyTextEditsToString(text, edits)).toBe('bar + bar')
  })

  it('handles edits across multiple lines', () => {
    const text = 'let foo = 1\nconst y = foo + foo'
    const edits = [
      { range: range(1, 5, 1, 8), text: 'bar' },
      { range: range(2, 11, 2, 14), text: 'bar' },
      { range: range(2, 17, 2, 20), text: 'bar' },
    ]
    expect(applyTextEditsToString(text, edits)).toBe('let bar = 1\nconst y = bar + bar')
  })

  it('supports insertions (empty range)', () => {
    expect(applyTextEditsToString('ab', [{ range: range(1, 2, 1, 2), text: 'X' }])).toBe('aXb')
  })

  it('returns the original text when there are no edits', () => {
    expect(applyTextEditsToString('unchanged', [])).toBe('unchanged')
  })
})

describe('stripSnippet', () => {
  it('keeps the default text of a placeholder', () => {
    expect(stripSnippet('![${1:alt text}](assets/x.png)')).toBe('![alt text](assets/x.png)')
    expect(stripSnippet('[${1:text}](a.md)')).toBe('[text](a.md)')
  })

  it('drops empty tab stops ($0, ${2}, $1)', () => {
    expect(stripSnippet('[${1:text}](a.md)$0')).toBe('[text](a.md)')
    expect(stripSnippet('a${2}b$1c')).toBe('abc')
  })

  it('unescapes \\$ \\} \\\\ to their literal characters', () => {
    expect(stripSnippet('price \\$5')).toBe('price $5')
    expect(stripSnippet('a\\}b')).toBe('a}b')
    expect(stripSnippet('a\\\\b')).toBe('a\\b')
  })

  it('leaves plain text untouched', () => {
    expect(stripSnippet('just [text](a.md) here')).toBe('just [text](a.md) here')
  })
})

/** In-memory IFileService with real fs semantics (parents, EEXIST/ENOENT/ENOTEMPTY),
 *  keyed by URI path. `file:///t/a.txt` lives at `/t/a.txt`. */
class InMemoryFiles implements Pick<
  IFileService,
  'exists' | 'readFileText' | 'writeFile' | 'createDirectory' | 'rename' | 'delete'
> {
  readonly files = new Map<string, string>()
  readonly dirs = new Set<string>(['/'])
  /** Fault injection: a rename whose source matches this path rejects. */
  failRenameFrom?: string

  private _norm(path: string): string {
    return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
  }

  private _parent(path: string): string {
    const idx = path.lastIndexOf('/')
    return idx <= 0 ? '/' : path.slice(0, idx)
  }

  private _isDir(path: string): boolean {
    if (this.dirs.has(path)) return true
    const prefix = path === '/' ? '/' : `${path}/`
    for (const key of [...this.files.keys(), ...this.dirs]) {
      if (key.startsWith(prefix) && key !== path) return true
    }
    return false
  }

  private _has(path: string): boolean {
    return this.files.has(path) || this._isDir(path)
  }

  seedFile(path: string, content: string): void {
    let dir = this._parent(this._norm(path))
    const chain: string[] = []
    while (dir !== '/' && !this.dirs.has(dir)) {
      chain.push(dir)
      dir = this._parent(dir)
    }
    for (const d of chain) this.dirs.add(d)
    this.files.set(this._norm(path), content)
  }

  exists(resource: URI): Promise<boolean> {
    return Promise.resolve(this._has(this._norm(resource.path)))
  }

  readFileText(resource: URI): Promise<string> {
    const text = this.files.get(this._norm(resource.path))
    if (text === undefined) {
      return Promise.reject(new FileSystemError(`not found: ${resource.path}`, 'ENOENT'))
    }
    return Promise.resolve(text)
  }

  writeFile(resource: URI, content: Uint8Array | string): Promise<void> {
    const path = this._norm(resource.path)
    if (!this._isDir(this._parent(path))) {
      return Promise.reject(new FileSystemError(`no parent dir: ${path}`, 'ENOENT'))
    }
    this.files.set(path, typeof content === 'string' ? content : new TextDecoder().decode(content))
    return Promise.resolve()
  }

  createDirectory(resource: URI): Promise<void> {
    const path = this._norm(resource.path)
    const chain: string[] = []
    let cur = path
    while (cur !== '/' && !this.dirs.has(cur)) {
      chain.push(cur)
      cur = this._parent(cur)
    }
    for (const d of chain) this.dirs.add(d)
    this.dirs.add(path)
    return Promise.resolve()
  }

  rename(source: URI, target: URI, opts?: { overwrite?: boolean }): Promise<void> {
    const src = this._norm(source.path)
    const dst = this._norm(target.path)
    if (src === this.failRenameFrom) {
      return Promise.reject(new FileSystemError(`simulated rename failure: ${src}`, 'UNKNOWN'))
    }
    if (!this._has(src)) {
      return Promise.reject(new FileSystemError(`not found: ${src}`, 'ENOENT'))
    }
    if (opts?.overwrite !== true && this._has(dst)) {
      return Promise.reject(new FileSystemError(`exists: ${dst}`, 'EEXIST'))
    }
    if (this.files.has(src)) {
      this.files.set(dst, this.files.get(src)!)
      this.files.delete(src)
      return Promise.resolve()
    }
    const prefix = `${src}/`
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(prefix)) {
        this.files.set(`${dst}/${key.slice(prefix.length)}`, this.files.get(key)!)
        this.files.delete(key)
      }
    }
    for (const key of [...this.dirs]) {
      if (key.startsWith(prefix)) {
        this.dirs.delete(key)
        this.dirs.add(`${dst}/${key.slice(prefix.length)}`)
      }
    }
    this.dirs.delete(src)
    this.dirs.add(dst)
    return Promise.resolve()
  }

  delete(resource: URI, opts?: { recursive?: boolean; useTrash?: boolean }): Promise<void> {
    const path = this._norm(resource.path)
    if (this.files.delete(path)) return Promise.resolve()
    if (this._isDir(path)) {
      const prefix = `${path}/`
      const children = [...this.files.keys(), ...this.dirs].filter(
        (k) => k.startsWith(prefix) && k !== path,
      )
      if (children.length > 0 && opts?.recursive !== true) {
        return Promise.reject(new FileSystemError(`not empty: ${path}`, 'ENOTEMPTY'))
      }
      for (const key of children) {
        this.files.delete(key)
        this.dirs.delete(key)
      }
      this.dirs.delete(path)
      return Promise.resolve()
    }
    return Promise.reject(new FileSystemError(`not found: ${path}`, 'ENOENT'))
  }
}

const uri = (path: string) => ({ toString: () => `file://${path}` }) as never

const textEdit = (path: string, text: string, sl = 1, sc = 1, el = 1, ec = 1) => ({
  resource: uri(path),
  textEdit: { range: range(sl, sc, el, ec), text },
})

describe('FileBulkEditService file operations', () => {
  let files: InMemoryFiles
  let service: FileBulkEditService

  beforeEach(() => {
    files = new InMemoryFiles()
    service = new FileBulkEditService(files as unknown as IFileService)
  })

  it('creates a file, pre-creating missing parent directories', async () => {
    const result = await service.apply({ edits: [{ newResource: uri('/t/src/new.ts') }] })
    expect(result.isApplied).toBe(true)
    expect(await files.readFileText(URI.file('/t/src/new.ts'))).toBe('')
  })

  it('create fails when the target exists (EEXIST)', async () => {
    files.seedFile('/t/a.ts', 'old')
    await expect(service.apply({ edits: [{ newResource: uri('/t/a.ts') }] })).rejects.toThrow(
      /already exists/,
    )
    expect(files.files.get('/t/a.ts')).toBe('old')
  })

  it('create with ignoreIfExists is a no-op on an existing file', async () => {
    files.seedFile('/t/a.ts', 'old')
    const result = await service.apply({
      edits: [{ newResource: uri('/t/a.ts'), options: { ignoreIfExists: true } }],
    })
    expect(result.isApplied).toBe(true)
    expect(files.files.get('/t/a.ts')).toBe('old')
  })

  it('create with overwrite truncates an existing file', async () => {
    files.seedFile('/t/a.ts', 'old')
    await service.apply({
      edits: [{ newResource: uri('/t/a.ts'), options: { overwrite: true } }],
    })
    expect(files.files.get('/t/a.ts')).toBe('')
  })

  it('renames a file, moving its content', async () => {
    files.seedFile('/t/old.ts', 'content')
    const result = await service.apply({
      edits: [{ oldResource: uri('/t/old.ts'), newResource: uri('/t/new.ts') }],
    })
    expect(result.isApplied).toBe(true)
    expect(files.files.has('/t/old.ts')).toBe(false)
    expect(files.files.get('/t/new.ts')).toBe('content')
  })

  it('rename fails when the target exists and overwrite is not set', async () => {
    files.seedFile('/t/old.ts', 'a')
    files.seedFile('/t/new.ts', 'b')
    await expect(
      service.apply({ edits: [{ oldResource: uri('/t/old.ts'), newResource: uri('/t/new.ts') }] }),
    ).rejects.toThrow()
    expect(files.files.get('/t/old.ts')).toBe('a')
    expect(files.files.get('/t/new.ts')).toBe('b')
  })

  it('rename with overwrite replaces the existing target', async () => {
    files.seedFile('/t/old.ts', 'a')
    files.seedFile('/t/new.ts', 'b')
    await service.apply({
      edits: [
        {
          oldResource: uri('/t/old.ts'),
          newResource: uri('/t/new.ts'),
          options: { overwrite: true },
        },
      ],
    })
    expect(files.files.has('/t/old.ts')).toBe(false)
    expect(files.files.get('/t/new.ts')).toBe('a')
  })

  it('rename with overwrite keeps the target intact when the rename itself fails', async () => {
    files.seedFile('/t/old.ts', 'a')
    files.seedFile('/t/new.ts', 'b')
    files.failRenameFrom = '/t/old.ts'
    await expect(
      service.apply({
        edits: [
          {
            oldResource: uri('/t/old.ts'),
            newResource: uri('/t/new.ts'),
            options: { overwrite: true },
          },
        ],
      }),
    ).rejects.toThrow(/simulated rename failure/)
    expect(files.files.get('/t/new.ts')).toBe('b')
    expect(files.files.get('/t/old.ts')).toBe('a')
  })

  it('rename with overwrite leaves no backup file behind on success', async () => {
    files.seedFile('/t/old.ts', 'a')
    files.seedFile('/t/new.ts', 'b')
    await service.apply({
      edits: [
        {
          oldResource: uri('/t/old.ts'),
          newResource: uri('/t/new.ts'),
          options: { overwrite: true },
        },
      ],
    })
    expect([...files.files.keys()].filter((k) => k.includes('rename-overwrite'))).toEqual([])
    expect(files.files.get('/t/new.ts')).toBe('a')
  })

  it('create with overwrite and ignoreIfExists truncates (overwrite wins)', async () => {
    files.seedFile('/t/a.ts', 'old')
    await service.apply({
      edits: [{ newResource: uri('/t/a.ts'), options: { overwrite: true, ignoreIfExists: true } }],
    })
    expect(files.files.get('/t/a.ts')).toBe('')
  })

  it('rename fails when the source is missing unless ignoreIfNotExists', async () => {
    await expect(
      service.apply({ edits: [{ oldResource: uri('/t/gone.ts'), newResource: uri('/t/x.ts') }] }),
    ).rejects.toThrow(/does not exist/)
    const result = await service.apply({
      edits: [
        {
          oldResource: uri('/t/gone.ts'),
          newResource: uri('/t/x.ts'),
          options: { ignoreIfNotExists: true },
        },
      ],
    })
    expect(result.isApplied).toBe(true)
  })

  it('deletes a file', async () => {
    files.seedFile('/t/a.ts', 'x')
    const result = await service.apply({ edits: [{ oldResource: uri('/t/a.ts') }] })
    expect(result.isApplied).toBe(true)
    expect(files.files.has('/t/a.ts')).toBe(false)
  })

  it('delete honours recursive for directories and fails otherwise', async () => {
    files.seedFile('/t/dir/a.ts', 'x')
    await expect(service.apply({ edits: [{ oldResource: uri('/t/dir') }] })).rejects.toThrow()
    await service.apply({
      edits: [{ oldResource: uri('/t/dir'), options: { recursive: true } }],
    })
    expect(files.files.has('/t/dir/a.ts')).toBe(false)
    expect(files.dirs.has('/t/dir')).toBe(false)
  })

  it('delete of a missing file fails unless ignoreIfNotExists', async () => {
    await expect(service.apply({ edits: [{ oldResource: uri('/t/gone.ts') }] })).rejects.toThrow(
      /does not exist/,
    )
    const result = await service.apply({
      edits: [{ oldResource: uri('/t/gone.ts'), options: { ignoreIfNotExists: true } }],
    })
    expect(result.isApplied).toBe(true)
  })

  it('applies text edits and file operations in documentChanges order', async () => {
    const result = await service.apply({
      edits: [
        { newResource: uri('/t/a.txt') },
        textEdit('/t/a.txt', 'hello'),
        { oldResource: uri('/t/a.txt'), newResource: uri('/t/b.txt') },
        textEdit('/t/b.txt', '!', 1, 6, 1, 6),
      ],
    })
    expect(result.isApplied).toBe(true)
    expect(files.files.has('/t/a.txt')).toBe(false)
    expect(files.files.get('/t/b.txt')).toBe('hello!')
  })

  it('aborts remaining operations when one fails (no rollback of earlier ones)', async () => {
    files.seedFile('/t/existing.txt', 'keep')
    await expect(
      service.apply({
        edits: [
          { newResource: uri('/t/first.txt') },
          { newResource: uri('/t/existing.txt') },
          { newResource: uri('/t/never.txt') },
        ],
      }),
    ).rejects.toThrow(/already exists/)
    expect(files.files.has('/t/first.txt')).toBe(true)
    expect(files.files.has('/t/never.txt')).toBe(false)
  })

  it('still rejects edits that are neither text nor file operations', async () => {
    await expect(service.apply({ edits: [{ kind: 'custom', something: true }] })).rejects.toThrow(
      /unsupported edit/,
    )
  })
})
