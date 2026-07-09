/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/configurationResolver/ConfigurationResolverService.ts
 *
 *  Constructs the service directly with fakes for its DI deps and asserts the
 *  renderer data sources (workspace / active editor / config / host / env snapshot)
 *  feed the ported variable grammar correctly.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  observableValue,
  URI,
  type IConfigurationService,
  type IEditorService,
  type IHostService,
  type IWorkspace,
  type IWorkspaceService,
} from '@universe-editor/platform'
import type {
  IEnvironmentSnapshot,
  IEnvironmentSnapshotService,
} from '../../../../shared/ipc/environmentSnapshotService.js'
import { ConfigurationResolverService } from '../ConfigurationResolverService.js'

function makeWorkspace(folderFsPath: string | null, name = 'proj'): IWorkspaceService {
  const current: IWorkspace | null = folderFsPath ? { folder: URI.file(folderFsPath), name } : null
  return {
    _serviceBrand: undefined,
    current,
    onDidChangeWorkspace: () => ({ dispose() {} }),
    recent: [],
    onDidChangeRecent: () => ({ dispose() {} }),
    whenReady: Promise.resolve(),
    openFolder: async () => {},
    closeFolder: async () => {},
    removeRecent: async () => {},
    clearRecent: async () => {},
  } as unknown as IWorkspaceService
}

function makeEditor(activeFsPath: string | undefined): IEditorService {
  const active = activeFsPath ? ({ resource: URI.file(activeFsPath) } as never) : undefined
  return {
    _serviceBrand: undefined,
    activeEditor: observableValue('activeEditor', active),
  } as unknown as IEditorService
}

function makeConfig(values: Record<string, unknown> = {}): IConfigurationService {
  return {
    _serviceBrand: undefined,
    get: <T>(key: string) => values[key] as T | undefined,
  } as unknown as IConfigurationService
}

function makeHost(platform: IHostService['platform']): IHostService {
  return { _serviceBrand: undefined, platform } as unknown as IHostService
}

function makeSnapshot(snapshot: IEnvironmentSnapshot): IEnvironmentSnapshotService {
  return {
    _serviceBrand: undefined,
    getSnapshot: async () => snapshot,
  }
}

const DEFAULT_SNAPSHOT: IEnvironmentSnapshot = {
  userHome: '/home/user',
  cwd: '/main/cwd',
  env: { FOO: 'bar' },
}

function makeService(opts: {
  folder?: string | null
  file?: string
  config?: Record<string, unknown>
  platform?: IHostService['platform']
  snapshot?: IEnvironmentSnapshot
}): ConfigurationResolverService {
  return new ConfigurationResolverService(
    makeWorkspace(opts.folder ?? null),
    makeEditor(opts.file),
    makeConfig(opts.config),
    makeHost(opts.platform ?? 'linux'),
    makeSnapshot(opts.snapshot ?? DEFAULT_SNAPSHOT),
  )
}

function folderScope(fsPath: string, name = 'proj') {
  return { uri: URI.file(fsPath), name }
}

describe('ConfigurationResolverService (renderer)', () => {
  it('resolves ${workspaceFolder} from the current workspace', async () => {
    const svc = makeService({ folder: '/home/user/proj' })
    expect(await svc.resolveAsync(folderScope('/home/user/proj'), '${workspaceFolder}/src')).toBe(
      '/home/user/proj/src',
    )
  })

  it('throws when ${workspaceFolder} is used with no workspace open', async () => {
    const svc = makeService({ folder: null })
    // Matches VSCode: an unresolvable ${workspaceFolder} raises rather than
    // silently vanishing. The terminal consumer catches this and falls back.
    await expect(svc.resolveAsync(undefined, '${workspaceFolder}/src')).rejects.toThrow()
  })

  it('resolves ${env:NAME} from the main-process snapshot', async () => {
    const svc = makeService({ snapshot: { ...DEFAULT_SNAPSHOT, env: { MY: 'value' } } })
    expect(await svc.resolveAsync(undefined, '${env:MY}')).toBe('value')
  })

  it('resolves ${userHome} from the snapshot', async () => {
    const svc = makeService({ snapshot: { ...DEFAULT_SNAPSHOT, userHome: '/home/alice' } })
    expect(await svc.resolveAsync(undefined, '${userHome}/.config')).toBe('/home/alice/.config')
  })

  it('resolves ${config:section} from configuration', async () => {
    const svc = makeService({ config: { 'terminal.integrated.cwd': '/from/config' } })
    expect(await svc.resolveAsync(undefined, '${config:terminal.integrated.cwd}')).toBe(
      '/from/config',
    )
  })

  it('resolves file variables from the active editor', async () => {
    const svc = makeService({ file: '/home/user/proj/src/app.ts' })
    expect(await svc.resolveAsync(undefined, '${file}')).toBe('/home/user/proj/src/app.ts')
    expect(await svc.resolveAsync(undefined, '${fileBasename}')).toBe('app.ts')
    expect(await svc.resolveAsync(undefined, '${fileDirname}')).toBe('/home/user/proj/src')
  })

  it('resolves ${pathSeparator} from the host platform', async () => {
    expect(
      await makeService({ platform: 'win32' }).resolveAsync(undefined, '${pathSeparator}'),
    ).toBe('\\')
    expect(
      await makeService({ platform: 'linux' }).resolveAsync(undefined, '${pathSeparator}'),
    ).toBe('/')
  })

  it('resolves ${workspaceFolder} scoped to the active folder param', async () => {
    const svc = makeService({ folder: '/home/user/proj' })
    expect(await svc.resolveAsync(undefined, '${workspaceFolder:proj}')).toBe('/home/user/proj')
  })
})
