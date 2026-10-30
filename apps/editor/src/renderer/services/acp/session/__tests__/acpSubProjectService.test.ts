/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for apps/editor/src/renderer/services/acp/session/acpSubProjectService.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Emitter,
  Event,
  LogLevel,
  NullLogger,
  REMOTE_SCHEME,
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
import { StubLoggerService } from '../../../../__tests__/_helpers/stubLoggerService.js'

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

function makeMutableConfigService(values: Record<string, unknown> = {}): {
  service: IConfigurationService
  fireProjectRootsChanged: () => void
} {
  const onDidChange = new Emitter<{ affectsConfiguration(key: string): boolean }>()
  return {
    service: {
      get: (key: string, defaultValue?: unknown) => (key in values ? values[key] : defaultValue),
      onDidChangeConfiguration: onDidChange.event,
    } as unknown as IConfigurationService,
    fireProjectRootsChanged: () =>
      onDidChange.fire({ affectsConfiguration: (key) => key === 'acp.projectRoots' }),
  }
}

class CapturingLogger extends NullLogger {
  readonly warns: string[] = []
  override warn(message: string): void {
    this.warns.push(message)
  }
}

class CapturingLoggerService implements ILoggerService {
  declare readonly _serviceBrand: undefined
  readonly logger = new CapturingLogger()
  createLogger(): ILogger {
    return this.logger
  }
  setLevel(): void {}
  getLevel(): LogLevel {
    return LogLevel.Info
  }
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
  loggerService?: ILoggerService
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
    opts.loggerService ?? new StubLoggerService(),
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

describe('AcpSubProjectService.getHydratableConfiguredScopes', () => {
  let made: ReturnType<typeof makeService>
  afterEach(() => {
    made.svc.dispose()
  })

  it('matches getScopes when every configured root exists and there is no active editor', async () => {
    made = makeService({
      config: makeConfigService({ 'acp.projectRoots': ['/ws/lib'] }),
      fileService: makeFileService([], ['/ws/lib']),
    })
    expect(await made.svc.getHydratableConfiguredScopes()).toEqual(await made.svc.getScopes())
  })

  it('drops a configured root that does not exist', async () => {
    made = makeService({
      config: makeConfigService({
        'acp.projectRoots': ['legacy/missing-project'],
      }),
    })
    expect(await made.svc.getHydratableConfiguredScopes()).toEqual([
      { cwd: '/ws', source: 'workspace', label: 'Workspace' },
    ])
  })

  it('keeps a configured root when the existence probe fails', async () => {
    const inner = makeFileService([], ['/ws/remote'])
    const fileService = {
      stat: inner.stat.bind(inner),
      exists: async (resource: URI) => {
        if (normalizeFsPath(resource.fsPath) === normalizeFsPath('/ws/remote')) {
          throw new Error('remote connection closed')
        }
        return inner.exists(resource)
      },
    } as unknown as IFileService
    made = makeService({
      config: makeConfigService({ 'acp.projectRoots': ['/ws/remote'] }),
      fileService,
    })
    expect((await made.svc.getHydratableConfiguredScopes()).map((s) => s.cwd)).toEqual([
      '/ws',
      '/ws/remote',
    ])
  })

  it('probes remote roots through their workspace authority', async () => {
    const folder = URI.from({ scheme: REMOTE_SCHEME, authority: 'host', path: '/ws' })
    const workspace = new FakeWorkspaceService({ folder, name: 'ws' })
    const probes: URI[] = []
    const fileService = {
      exists: async (resource: URI) => {
        probes.push(resource)
        return true
      },
      stat: async (resource: URI): Promise<IFileStat> => ({
        resource,
        isDirectory: true,
        isFile: false,
        size: 0,
        mtime: 0,
      }),
    } as unknown as IFileService
    made = makeService({
      workspace,
      config: makeConfigService({ 'acp.projectRoots': ['lib'] }),
      fileService,
    })
    await made.svc.getHydratableConfiguredScopes()
    expect(probes).toHaveLength(1)
    expect(probes[0]?.scheme).toBe(REMOTE_SCHEME)
    expect(probes[0]?.authority).toBe('host')
    expect(probes[0]?.path).toBe('/ws/lib')
  })

  it('warns once per missing root until the config changes', async () => {
    const config = makeMutableConfigService({ 'acp.projectRoots': ['/ws/gone'] })
    const loggerService = new CapturingLoggerService()
    made = makeService({ config: config.service, loggerService })
    await made.svc.getHydratableConfiguredScopes()
    await made.svc.getHydratableConfiguredScopes()
    const missingWarns = (): string[] =>
      loggerService.logger.warns.filter((m) => m.includes('does not exist'))
    expect(missingWarns()).toHaveLength(1)

    config.fireProjectRootsChanged()
    await made.svc.getHydratableConfiguredScopes()
    expect(missingWarns()).toHaveLength(2)
  })

  // The restore coordinator reads this instead of getScopes precisely to skip
  // the upward marker walk: hydrating a detected root would spawn an agent for
  // a directory with no sessions, so paying for the probe is pure waste.
  it('omits the detected root and performs no marker probing or configured-root IO', async () => {
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

    expect(await made.svc.getHydratableConfiguredScopes()).toEqual([
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
