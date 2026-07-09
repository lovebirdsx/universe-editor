/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/configurationResolver/variableResolver.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI } from '../../base/uri.js'
import type { HostPlatform } from '../../host/hostService.js'
import {
  AbstractVariableResolverService,
  type IVariableResolveContext,
} from '../../configurationResolver/variableResolver.js'
import type {
  IProcessEnvironment,
  IWorkspaceFolderData,
} from '../../configurationResolver/configurationResolver.js'

class TestResolver extends AbstractVariableResolverService {
  constructor(
    context: Partial<IVariableResolveContext>,
    platform: HostPlatform,
    userHome?: string,
    env?: IProcessEnvironment,
  ) {
    const full: IVariableResolveContext = {
      getFolderUri: () => undefined,
      getWorkspaceFolderCount: () => 0,
      getConfigurationValue: () => undefined,
      getExecPath: () => undefined,
      getFilePath: () => undefined,
      getSelectedText: () => undefined,
      getLineNumber: () => undefined,
      getColumnNumber: () => undefined,
      getExtension: async () => undefined,
      ...context,
    }
    super(
      full,
      platform,
      userHome !== undefined ? Promise.resolve(userHome) : undefined,
      env !== undefined ? Promise.resolve(env) : undefined,
    )
  }
}

function folder(fsPath: string): IWorkspaceFolderData {
  return { uri: URI.file(fsPath), name: 'ws' }
}

describe('AbstractVariableResolverService', () => {
  it('resolves ${workspaceFolder} from the scoped folder', async () => {
    const r = new TestResolver({}, 'linux')
    const out = await r.resolveAsync(folder('/home/x/proj'), '${workspaceFolder}/src')
    expect(out).toBe('/home/x/proj/src')
  })

  it('resolves ${workspaceFolderBasename}', async () => {
    const r = new TestResolver({}, 'linux')
    const out = await r.resolveAsync(folder('/home/x/proj'), '${workspaceFolderBasename}')
    expect(out).toBe('proj')
  })

  it('uppercases the Windows drive letter of ${workspaceFolder}', async () => {
    const r = new TestResolver({}, 'win32')
    const out = await r.resolveAsync(folder('c:/proj'), '${workspaceFolder}')
    expect(out).toBe('C:/proj')
  })

  it('resolves ${env:NAME} from the environment snapshot', async () => {
    const r = new TestResolver({}, 'linux', undefined, { FOO: 'bar' })
    const out = await r.resolveAsync(undefined, '${env:FOO}')
    expect(out).toBe('bar')
  })

  it('resolves ${env:NAME} case-insensitively on win32', async () => {
    const r = new TestResolver({}, 'win32', undefined, { Path: 'C:/bin' })
    const out = await r.resolveAsync(undefined, '${env:PATH}')
    expect(out).toBe('C:/bin')
  })

  it('resolves unknown ${env:NAME} to empty string', async () => {
    const r = new TestResolver({}, 'linux', undefined, {})
    const out = await r.resolveAsync(undefined, '[${env:MISSING}]')
    expect(out).toBe('[]')
  })

  it('resolves ${userHome}', async () => {
    const r = new TestResolver({}, 'linux', '/home/x')
    const out = await r.resolveAsync(undefined, '${userHome}/.config')
    expect(out).toBe('/home/x/.config')
  })

  it('resolves ${pathSeparator} to the platform separator', async () => {
    expect(await new TestResolver({}, 'win32').resolveAsync(undefined, '${pathSeparator}')).toBe(
      '\\',
    )
    expect(await new TestResolver({}, 'linux').resolveAsync(undefined, '${/}')).toBe('/')
  })

  it('resolves file variables from the active editor path', async () => {
    const r = new TestResolver({ getFilePath: () => '/home/x/proj/src/app.ts' }, 'linux')
    expect(await r.resolveAsync(undefined, '${file}')).toBe('/home/x/proj/src/app.ts')
    expect(await r.resolveAsync(undefined, '${fileBasename}')).toBe('app.ts')
    expect(await r.resolveAsync(undefined, '${fileBasenameNoExtension}')).toBe('app')
    expect(await r.resolveAsync(undefined, '${fileExtname}')).toBe('.ts')
    expect(await r.resolveAsync(undefined, '${fileDirname}')).toBe('/home/x/proj/src')
  })

  it('resolves ${relativeFile} against the workspace folder', async () => {
    const r = new TestResolver({ getFilePath: () => '/home/x/proj/src/app.ts' }, 'linux')
    expect(await r.resolveAsync(folder('/home/x/proj'), '${relativeFile}')).toBe('src/app.ts')
  })

  it('resolves ${config:section}', async () => {
    const r = new TestResolver(
      { getConfigurationValue: (_f, s) => (s === 'terminal.integrated.cwd' ? '/cfg' : undefined) },
      'linux',
    )
    expect(await r.resolveAsync(undefined, '${config:terminal.integrated.cwd}')).toBe('/cfg')
  })

  it('resolves ${workspaceFolder:name} via the folder argument', async () => {
    const r = new TestResolver(
      { getFolderUri: (n) => (n === 'other' ? URI.file('/ws/other') : undefined) },
      'linux',
    )
    expect(await r.resolveAsync(undefined, '${workspaceFolder:other}')).toBe('/ws/other')
  })

  it('leaves an unknown variable as its literal id', async () => {
    const r = new TestResolver({}, 'linux')
    expect(await r.resolveAsync(undefined, '${totallyUnknown}')).toBe('${totallyUnknown}')
  })

  it('resolveWithEnvironment injects a per-call environment', async () => {
    const r = new TestResolver({}, 'linux')
    const out = await r.resolveWithEnvironment({ FOO: 'live' }, undefined, '${env:FOO}')
    expect(out).toBe('live')
  })
})
