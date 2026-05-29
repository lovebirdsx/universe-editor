/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/search/TextSearchService.ts
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  Event,
  IFileService,
  ILoggerService,
  IWorkspaceService,
  InstantiationService,
  LogLevel,
  ServiceCollection,
  URI,
  type IDirectoryEntry,
  type IFileService as IFileServiceType,
  type IFileStat,
  type ILogger,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import { TextSearchService } from '../TextSearchService.js'

interface FakeFs extends IFileServiceType {
  dirs: Map<string, IDirectoryEntry[]>
  files: Map<string, string>
  listCalls: string[]
  readCalls: string[]
  setListError?: (resource: URI) => boolean
}

function makeFs(): FakeFs {
  const dirs = new Map<string, IDirectoryEntry[]>()
  const files = new Map<string, string>()
  const listCalls: string[] = []
  const readCalls: string[] = []
  const fs: FakeFs = {
    _serviceBrand: undefined,
    dirs,
    files,
    listCalls,
    readCalls,
    async readFile() {
      throw new Error('not used')
    },
    async readFileText(resource: URI) {
      readCalls.push(resource.toString())
      const v = files.get(resource.toString())
      if (v === undefined) throw new Error('ENOENT')
      return v
    },
    async writeFile() {},
    async exists(resource: URI) {
      return files.has(resource.toString()) || dirs.has(resource.toString())
    },
    async stat(resource: URI): Promise<IFileStat> {
      const v = files.get(resource.toString())
      return {
        resource,
        isFile: v !== undefined,
        isDirectory: dirs.has(resource.toString()),
        size: v !== undefined ? v.length : 0,
        mtime: 0,
      }
    },
    async list(resource: URI) {
      if (fs.setListError?.(resource)) throw new Error('boom')
      listCalls.push(resource.toString())
      return dirs.get(resource.toString()) ?? []
    },
    async createDirectory() {},
    async delete() {},
    async rename() {},
    async listRecursive() {
      return []
    },
  } as FakeFs
  return fs
}

class FakeWorkspace implements IWorkspaceServiceType {
  declare readonly _serviceBrand: undefined
  readonly onDidChangeWorkspace = new Emitter<IWorkspace | null>().event
  readonly onDidChangeRecent = new Emitter<readonly never[]>().event
  current: IWorkspace | null
  readonly recent = [] as never[]
  readonly whenReady: Promise<void> = Promise.resolve()
  constructor(root: URI | null) {
    this.current = root ? { folder: root, name: 'ws' } : null
  }
  async openFolder() {}
  async closeFolder() {}
  async clearRecent() {}
  async removeRecent() {}
}

function addFile(fs: FakeFs, parent: URI, name: string, content: string): URI {
  const uri = URI.joinPath(parent, name)
  fs.files.set(uri.toString(), content)
  const list = fs.dirs.get(parent.toString()) ?? []
  list.push({ name, isFile: true, isDirectory: false })
  fs.dirs.set(parent.toString(), list)
  return uri
}

function addDir(fs: FakeFs, parent: URI, name: string): URI {
  const uri = URI.joinPath(parent, name)
  if (!fs.dirs.has(uri.toString())) fs.dirs.set(uri.toString(), [])
  const list = fs.dirs.get(parent.toString()) ?? []
  if (!list.some((e) => e.name === name)) {
    list.push({ name, isFile: false, isDirectory: true })
  }
  fs.dirs.set(parent.toString(), list)
  return uri
}

function makeLogger(): ILogger {
  return {
    level: LogLevel.Info,
    onDidChangeLogLevel: Event.None,
    setLevel: vi.fn(),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
    dispose: vi.fn(),
  }
}

function makeInst(
  fs: IFileServiceType,
  ws: IWorkspaceServiceType,
  logger?: ILogger,
): InstantiationService {
  const services = new ServiceCollection()
  services.set(IFileService, fs)
  services.set(IWorkspaceService, ws)
  if (logger) {
    services.set(ILoggerService, {
      _serviceBrand: undefined,
      createLogger: () => logger,
      setLevel: () => {},
      getLevel: () => LogLevel.Info,
    })
  }
  return new InstantiationService(services)
}

const root = URI.file('/ws')

describe('TextSearchService', () => {
  let fs: FakeFs
  let ws: FakeWorkspace
  let svc: TextSearchService

  beforeEach(() => {
    fs = makeFs()
    fs.dirs.set(root.toString(), [])
    ws = new FakeWorkspace(root)
    svc = makeInst(fs, ws).createInstance(TextSearchService)
  })

  it('finds a single match in one file', async () => {
    addFile(fs, root, 'a.ts', 'const x = foo()\n')
    const results = await svc.search({
      pattern: 'foo',
      isRegex: false,
      matchCase: false,
      matchWholeWord: false,
      includes: [],
      excludes: [],
    })
    expect(results).toHaveLength(1)
    expect(results[0]?.matches[0]?.ranges).toHaveLength(1)
  })

  it('logs search completion summaries without logging the query text', async () => {
    const logger = makeLogger()
    const loggedSvc = makeInst(fs, ws, logger).createInstance(TextSearchService)
    addFile(fs, root, 'a.ts', 'const x = foo()\n')

    await loggedSvc.search({
      pattern: 'foo',
      isRegex: false,
      matchCase: false,
      matchWholeWord: false,
      includes: [],
      excludes: [],
    })

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('search finished files=1'))
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('pattern=foo'))
  })

  it('recurses into subdirectories', async () => {
    const sub = addDir(fs, root, 'sub')
    addFile(fs, sub, 'b.ts', 'foo here')
    const results = await svc.search({
      pattern: 'foo',
      isRegex: false,
      matchCase: false,
      matchWholeWord: false,
      includes: [],
      excludes: [],
    })
    expect(results).toHaveLength(1)
    expect((URI.revive(results[0]!.resource) as URI).toString()).toBe(
      URI.joinPath(sub, 'b.ts').toString(),
    )
  })

  it('skips hard-ignored directories (node_modules, .git)', async () => {
    const nm = addDir(fs, root, 'node_modules')
    addFile(fs, nm, 'pkg.js', 'foo')
    const git = addDir(fs, root, '.git')
    addFile(fs, git, 'HEAD', 'foo')
    addFile(fs, root, 'real.ts', 'foo')
    const results = await svc.search({
      pattern: 'foo',
      isRegex: false,
      matchCase: false,
      matchWholeWord: false,
      includes: [],
      excludes: [],
    })
    expect(results).toHaveLength(1)
  })

  it('include glob filters files', async () => {
    addFile(fs, root, 'a.ts', 'foo')
    addFile(fs, root, 'b.js', 'foo')
    const results = await svc.search({
      pattern: 'foo',
      isRegex: false,
      matchCase: false,
      matchWholeWord: false,
      includes: ['**/*.ts'],
      excludes: [],
    })
    expect(results).toHaveLength(1)
    expect((URI.revive(results[0]!.resource) as URI).path).toContain('a.ts')
  })

  it('exclude glob filters files', async () => {
    addFile(fs, root, 'a.ts', 'foo')
    addFile(fs, root, 'a.test.ts', 'foo')
    const results = await svc.search({
      pattern: 'foo',
      isRegex: false,
      matchCase: false,
      matchWholeWord: false,
      includes: [],
      excludes: ['**/*.test.ts'],
    })
    expect(results).toHaveLength(1)
    expect((URI.revive(results[0]!.resource) as URI).path).toContain('a.ts')
  })

  it('caps at maxFiles and reports limitHit=files', async () => {
    for (let i = 0; i < 5; i++) addFile(fs, root, `f${i}.ts`, 'foo')
    const progress: ('files' | 'matches' | 'matchesPerFile' | undefined)[] = []
    const results = await svc.search(
      {
        pattern: 'foo',
        isRegex: false,
        matchCase: false,
        matchWholeWord: false,
        includes: [],
        excludes: [],
        maxFiles: 2,
      },
      { onProgress: (p) => progress.push(p.limitHit) },
    )
    expect(results.length).toBeLessThanOrEqual(2)
    expect(progress.some((l) => l === 'files')).toBe(true)
  })

  it('caps matches per file and reports limitHit=matchesPerFile', async () => {
    addFile(fs, root, 'a.ts', 'foo foo foo foo foo')
    const progress: ('files' | 'matches' | 'matchesPerFile' | undefined)[] = []
    await svc.search(
      {
        pattern: 'foo',
        isRegex: false,
        matchCase: false,
        matchWholeWord: false,
        includes: [],
        excludes: [],
        maxMatchesPerFile: 2,
      },
      { onProgress: (p) => progress.push(p.limitHit) },
    )
    expect(progress.some((l) => l === 'matchesPerFile')).toBe(true)
  })

  it('caps total matches and reports limitHit=matches', async () => {
    addFile(fs, root, 'a.ts', 'foo foo foo')
    addFile(fs, root, 'b.ts', 'foo foo foo')
    const progress: ('files' | 'matches' | 'matchesPerFile' | undefined)[] = []
    await svc.search(
      {
        pattern: 'foo',
        isRegex: false,
        matchCase: false,
        matchWholeWord: false,
        includes: [],
        excludes: [],
        maxResults: 2,
      },
      { onProgress: (p) => progress.push(p.limitHit) },
    )
    expect(progress.some((l) => l === 'matches')).toBe(true)
  })

  it('honours AbortSignal mid-way', async () => {
    for (let i = 0; i < 100; i++) addFile(fs, root, `f${i}.ts`, 'foo')
    const ac = new AbortController()
    // Abort immediately so the loop bails on the first signal check.
    ac.abort()
    const results = await svc.search(
      {
        pattern: 'foo',
        isRegex: false,
        matchCase: false,
        matchWholeWord: false,
        includes: [],
        excludes: [],
      },
      { signal: ac.signal },
    )
    expect(results.length).toBeLessThan(100)
  })

  it('fires onProgress at least once at the end', async () => {
    addFile(fs, root, 'a.ts', 'foo')
    const onProgress = vi.fn()
    await svc.search(
      {
        pattern: 'foo',
        isRegex: false,
        matchCase: false,
        matchWholeWord: false,
        includes: [],
        excludes: [],
      },
      { onProgress },
    )
    expect(onProgress).toHaveBeenCalled()
  })

  it('silently swallows read failures and keeps scanning', async () => {
    addFile(fs, root, 'good.ts', 'foo')
    // Add an entry whose readFileText will throw.
    const list = fs.dirs.get(root.toString())!
    list.push({ name: 'broken.ts', isFile: true, isDirectory: false })
    // No content in files map → readFileText throws ENOENT.
    const results = await svc.search({
      pattern: 'foo',
      isRegex: false,
      matchCase: false,
      matchWholeWord: false,
      includes: [],
      excludes: [],
    })
    expect(results).toHaveLength(1)
  })

  it('returns empty array when no workspace is open', async () => {
    const svc2 = makeInst(fs, new FakeWorkspace(null)).createInstance(TextSearchService)
    const results = await svc2.search({
      pattern: 'foo',
      isRegex: false,
      matchCase: false,
      matchWholeWord: false,
      includes: [],
      excludes: [],
    })
    expect(results).toEqual([])
  })
})
