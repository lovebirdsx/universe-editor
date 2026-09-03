/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for apps/editor/src/renderer/services/acp/session/acpSubProjectService.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Event,
  LogLevel,
  NullLogger,
  URI,
  UriIdentityService,
  normalizeFsPath,
  observableValue,
  type IConfigurationService,
  type IEditorInput,
  type IEditorService,
  type IFileService,
  type IFileStat,
  type ILogger,
  type ILoggerService,
  type IWorkspace,
  type IWorkspaceService,
} from '@universe-editor/platform'
import { FileEditorInput } from '../../../editor/FileEditorInput.js'
import { AcpSubProjectService } from '../acpSubProjectService.js'

function makeFakeWorkspace(path: string): IWorkspace {
  return { folder: URI.file(path), name: path }
}

class FakeWorkspaceService implements IWorkspaceService {
  declare readonly _serviceBrand: undefined
  readonly recent = []
  readonly onDidChangeRecent = Event.None
  readonly onDidChangeWorkspace = Event.None
  readonly whenReady: Promise<void> = Promise.resolve()
  constructor(private _current: IWorkspace | null = makeFakeWorkspace('/ws')) {}
  get current(): IWorkspace | null {
    return this._current
  }
  async openFolder(): Promise<void> {}
  async closeFolder(): Promise<void> {}
  async removeRecent(): Promise<void> {}
  async clearRecent(): Promise<void> {}
}

function makeConfigService(values: Record<string, unknown> = {}): IConfigurationService {
  return {
    get: (key: string, defaultValue?: unknown) => (key in values ? values[key] : defaultValue),
    onDidChangeConfiguration: Event.None,
  } as unknown as IConfigurationService
}

function makeFileService(
  files: readonly string[] = [],
  dirs: readonly string[] = [],
): IFileService {
  const fileSet = new Set(files.map((p) => normalizeFsPath(p)))
  const dirSet = new Set(dirs.map((p) => normalizeFsPath(p)))
  const stat = async (resource: URI): Promise<IFileStat> => {
    const p = normalizeFsPath(resource.fsPath)
    if (dirSet.has(p)) return { resource, isDirectory: true, isFile: false, size: 0, mtime: 0 }
    if (fileSet.has(p)) return { resource, isDirectory: false, isFile: true, size: 0, mtime: 0 }
    throw new Error('ENOENT')
  }
  return {
    exists: async (resource: URI) => {
      const p = normalizeFsPath(resource.fsPath)
      return fileSet.has(p) || dirSet.has(p)
    },
    stat,
  } as unknown as IFileService
}

class StubLoggerService implements ILoggerService {
  declare readonly _serviceBrand: undefined
  createLogger(): ILogger {
    return new NullLogger()
  }
  setLevel(): void {}
  getLevel(): LogLevel {
    return LogLevel.Info
  }
}

function makeEditorService(): {
  editor: IEditorService
  setActive: (input: IEditorInput | undefined) => void
} {
  const activeEditor = observableValue<IEditorInput | undefined>('test.activeEditor', undefined)
  return {
    editor: { activeEditor } as unknown as IEditorService,
    setActive: (input) => activeEditor.set(input, undefined),
  }
}

interface MakeOptions {
  workspace?: FakeWorkspaceService
  config?: IConfigurationService
  fileService?: IFileService
  editor?: ReturnType<typeof makeEditorService>
}

function makeService(opts: MakeOptions = {}): {
  svc: AcpSubProjectService
  editor: ReturnType<typeof makeEditorService>
} {
  const editor = opts.editor ?? makeEditorService()
  const svc = new AcpSubProjectService(
    opts.workspace ?? new FakeWorkspaceService(),
    opts.fileService ?? makeFileService(),
    new UriIdentityService('linux'),
    opts.config ?? makeConfigService(),
    editor.editor,
    new StubLoggerService(),
  )
  return { svc, editor }
}

describe('AcpSubProjectService.getScopes', () => {
  let made: ReturnType<typeof makeService>
  beforeEach(() => {
    made = makeService()
  })
  afterEach(() => {
    made.svc.dispose()
  })

  it('lists the workspace root as the first item with label Workspace', async () => {
    const scopes = await made.svc.getScopes()
    expect(scopes).toEqual([{ cwd: '/ws', source: 'workspace', label: 'Workspace' }])
  })

  it('returns an empty list when there is no workspace', async () => {
    made.svc.dispose()
    made = makeService({ workspace: new FakeWorkspaceService(null) })
    expect(await made.svc.getScopes()).toEqual([])
  })

  it('resolves relative and absolute acp.projectRoots entries', async () => {
    made.svc.dispose()
    made = makeService({
      config: makeConfigService({ 'acp.projectRoots': ['Source/Client', '/ws/lib'] }),
    })
    const scopes = await made.svc.getScopes()
    expect(scopes).toEqual([
      { cwd: '/ws', source: 'workspace', label: 'Workspace' },
      { cwd: '/ws/Source/Client', source: 'configured', label: 'Source/Client' },
      { cwd: '/ws/lib', source: 'configured', label: 'lib' },
    ])
  })

  it('deduplicates a configured root that overlaps the workspace root', async () => {
    made.svc.dispose()
    made = makeService({
      config: makeConfigService({ 'acp.projectRoots': ['/ws', '/ws/lib'] }),
    })
    const scopes = await made.svc.getScopes()
    expect(scopes).toEqual([
      { cwd: '/ws', source: 'workspace', label: 'Workspace' },
      { cwd: '/ws/lib', source: 'configured', label: 'lib' },
    ])
  })

  it('appends the detected project of the active editor when it is not already listed', async () => {
    made.svc.dispose()
    const fileService = makeFileService(['/ws/a/package.json', '/ws/a/b/c.ts'])
    made = makeService({ fileService })
    made.editor.setActive(new FileEditorInput(URI.file('/ws/a/b/c.ts'), fileService))
    const scopes = await made.svc.getScopes()
    expect(scopes).toEqual([
      { cwd: '/ws', source: 'workspace', label: 'Workspace' },
      { cwd: '/ws/a', source: 'detected', label: 'a' },
    ])
  })
})

describe('AcpSubProjectService.getConfiguredScopes', () => {
  let made: ReturnType<typeof makeService>
  afterEach(() => {
    made.svc.dispose()
  })

  it('matches getScopes when there is no active editor', async () => {
    made = makeService({ config: makeConfigService({ 'acp.projectRoots': ['/ws/lib'] }) })
    expect(made.svc.getConfiguredScopes()).toEqual(await made.svc.getScopes())
  })

  // The restore coordinator reads this instead of getScopes precisely to skip
  // the upward marker walk: hydrating a detected root would spawn an agent for
  // a directory with no sessions, so paying for the probe is pure waste.
  it('omits the detected root and performs no filesystem probing', async () => {
    let probes = 0
    const inner = makeFileService(['/ws/a/package.json', '/ws/a/b/c.ts'])
    const fileService = {
      stat: inner.stat.bind(inner),
      exists: async (resource: URI) => {
        probes++
        return inner.exists(resource)
      },
    } as unknown as IFileService
    made = makeService({ fileService })
    made.editor.setActive(new FileEditorInput(URI.file('/ws/a/b/c.ts'), fileService))

    expect(made.svc.getConfiguredScopes()).toEqual([
      { cwd: '/ws', source: 'workspace', label: 'Workspace' },
    ])
    expect(probes).toBe(0)

    // Same service, same active editor: getScopes still detects /ws/a.
    expect((await made.svc.getScopes()).map((s) => s.source)).toEqual(['workspace', 'detected'])
    expect(probes).toBeGreaterThan(0)
  })
})

describe('AcpSubProjectService.detectForResource', () => {
  let made: ReturnType<typeof makeService>
  beforeEach(() => {
    made = makeService()
  })
  afterEach(() => {
    made.svc.dispose()
  })

  it('returns undefined when the resource is outside the workspace', async () => {
    expect(await made.svc.detectForResource(URI.file('/other/x.ts'))).toBeUndefined()
  })

  it('returns undefined when no marker is found up to the workspace root', async () => {
    made.svc.dispose()
    made = makeService({ fileService: makeFileService(['/ws/x/y.ts']) })
    expect(await made.svc.detectForResource(URI.file('/ws/x/y.ts'))).toBeUndefined()
  })

  it('walks up and stops at the directory containing package.json', async () => {
    made.svc.dispose()
    made = makeService({
      fileService: makeFileService(['/ws/a/package.json', '/ws/a/b/c.ts']),
    })
    const scope = await made.svc.detectForResource(URI.file('/ws/a/b/c.ts'))
    expect(scope).toEqual({ cwd: '/ws/a', source: 'detected', label: 'a' })
  })

  it('walks up and stops at the directory containing p4config', async () => {
    made.svc.dispose()
    made = makeService({
      fileService: makeFileService(['/ws/pkg/p4config', '/ws/pkg/src/file.ts']),
    })
    const scope = await made.svc.detectForResource(URI.file('/ws/pkg/src/file.ts'))
    expect(scope).toEqual({ cwd: '/ws/pkg', source: 'detected', label: 'pkg' })
  })

  it('returns the configured scope when the resource is under a project root', async () => {
    made.svc.dispose()
    made = makeService({
      config: makeConfigService({ 'acp.projectRoots': ['/ws/lib'] }),
    })
    const scope = await made.svc.detectForResource(URI.file('/ws/lib/deep/file.ts'))
    expect(scope).toEqual({ cwd: '/ws/lib', source: 'configured', label: 'lib' })
  })

  it('does not detect when acp.subProject.detectEnabled is false', async () => {
    made.svc.dispose()
    made = makeService({
      fileService: makeFileService(['/ws/a/package.json', '/ws/a/b/c.ts']),
      config: makeConfigService({ 'acp.subProject.detectEnabled': false }),
    })
    expect(await made.svc.detectForResource(URI.file('/ws/a/b/c.ts'))).toBeUndefined()
  })

  it('honors a custom detectMarkers list', async () => {
    made.svc.dispose()
    made = makeService({
      fileService: makeFileService(['/ws/a/p4config.txt', '/ws/a/b/c.ts']),
      config: makeConfigService({ 'acp.subProject.detectMarkers': ['p4config.txt'] }),
    })
    // package.json is NOT a configured marker here, so detection follows p4config.txt.
    const scope = await made.svc.detectForResource(URI.file('/ws/a/b/c.ts'))
    expect(scope).toEqual({ cwd: '/ws/a', source: 'detected', label: 'a' })
  })
})

describe('AcpSubProjectService.detectActiveProject', () => {
  let made: ReturnType<typeof makeService>
  beforeEach(() => {
    made = makeService()
  })
  afterEach(() => {
    made.svc.dispose()
  })

  it('returns undefined when no editor is active', async () => {
    expect(await made.svc.detectActiveProject()).toBeUndefined()
  })

  it('detects the project of the active editor file', async () => {
    made.svc.dispose()
    const fileService = makeFileService(['/ws/a/package.json', '/ws/a/b/c.ts'])
    made = makeService({ fileService })
    made.editor.setActive(new FileEditorInput(URI.file('/ws/a/b/c.ts'), fileService))
    const scope = await made.svc.detectActiveProject()
    expect(scope).toEqual({ cwd: '/ws/a', source: 'detected', label: 'a' })
  })
})
