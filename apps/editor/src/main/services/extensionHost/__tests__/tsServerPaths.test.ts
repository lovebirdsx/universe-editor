/*---------------------------------------------------------------------------------------------
 *  Tests for the TS-server preference chain (binary env > selection env >
 *  workspace .universe-editor settings > workspace .vscode settings > user
 *  settings.json `js/ts.experimental.useTsgo` > shared default) and the
 *  native-binary resolver. Electron is mocked: resolveTsServerPaths walks up
 *  from app.getAppPath() in dev; the packaged tests flip app.isPackaged and
 *  point process.resourcesPath at a temp dir with a staged tsgo/ tree.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const appRoot = path.resolve(import.meta.dirname, '../../../../../../..')
const appPathHolder = { current: appRoot }

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => appPathHolder.current,
    getPath: () => '',
  },
}))

const { app } = await import('electron')
const { createTsServerSpecResolver, defaultTsServerPreference } =
  await import('../tsServerPaths.js')
const { DEFAULT_TS_SERVER_IMPLEMENTATION } =
  await import('../../../../shared/tsServerImplementation.js')

let settingsDir = ''

describe('tsServerPaths preference chain', () => {
  beforeEach(async () => {
    settingsDir = await mkdtemp(path.join(tmpdir(), 'universe-editor-ts-server-pref-'))
    vi.stubEnv('UNIVERSE_TS_SERVER', '')
    vi.stubEnv('UNIVERSE_TSGO_BIN', '')
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(settingsDir, { recursive: true, force: true })
  })

  it('defaults to the shared default when nothing is configured', () => {
    const spec = createTsServerSpecResolver(settingsDir)()
    expect(spec.kind).toBe(DEFAULT_TS_SERVER_IMPLEMENTATION)
  })

  it('settings.json selects native and resolves a real binary', async () => {
    await writeFile(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ 'js/ts.experimental.useTsgo': true }),
    )
    const spec = createTsServerSpecResolver(settingsDir)()
    expect(spec.kind).toBe('native')
    if (spec.kind === 'native') {
      expect(spec.binary).toMatch(/tsgo(\.exe)?$/)
    }
  })

  it('settings.json with tsls stays tsls', async () => {
    await writeFile(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ 'js/ts.experimental.useTsgo': false }),
    )
    expect(createTsServerSpecResolver(settingsDir)().kind).toBe('tsls')
  })

  it('falls back to the shared default for an unknown settings value', async () => {
    await writeFile(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ 'js/ts.experimental.useTsgo': 'v8-something' }),
    )
    expect(createTsServerSpecResolver(settingsDir)().kind).toBe(DEFAULT_TS_SERVER_IMPLEMENTATION)
  })

  it('ignores the legacy string "native" and falls back to the default', async () => {
    await writeFile(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ 'js/ts.experimental.useTsgo': 'native' }),
    )
    expect(createTsServerSpecResolver(settingsDir)().kind).toBe(DEFAULT_TS_SERVER_IMPLEMENTATION)
  })

  it('UNIVERSE_TS_SERVER beats settings.json', async () => {
    await writeFile(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ 'js/ts.experimental.useTsgo': false }),
    )
    vi.stubEnv('UNIVERSE_TS_SERVER', 'native')
    expect(createTsServerSpecResolver(settingsDir)().kind).toBe('native')
  })

  it('UNIVERSE_TSGO_BIN is the explicit binary override', async () => {
    await writeFile(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ 'js/ts.experimental.useTsgo': false }),
    )
    vi.stubEnv('UNIVERSE_TSGO_BIN', '/custom/tsgo')
    const spec = createTsServerSpecResolver(settingsDir)()
    expect(spec.kind).toBe('native')
    if (spec.kind === 'native') {
      expect(spec.binary).toBe('/custom/tsgo')
      expect(spec.version).toBe('unknown')
    }
  })

  it('re-reads settings.json on each resolution (host restart picks up edits)', async () => {
    const resolve = createTsServerSpecResolver(settingsDir)
    expect(resolve().kind).toBe(DEFAULT_TS_SERVER_IMPLEMENTATION)
    await writeFile(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ 'js/ts.experimental.useTsgo': false }),
    )
    expect(resolve().kind).toBe('tsls')
  })

  it('tsls spec carries the typescript package version', async () => {
    // The vendored node_modules only exists after scripts/release/vendor-install.mjs;
    // stage a fake tree so the test doesn't depend on that install.
    const vendorDir = await mkdtemp(path.join(tmpdir(), 'universe-editor-tsls-vendor-'))
    const vendorRoot = path.join(vendorDir, 'vendor/typescript-language-server/node_modules')
    await mkdir(path.join(vendorRoot, 'typescript-language-server/lib'), { recursive: true })
    await writeFile(path.join(vendorRoot, 'typescript-language-server/lib/cli.mjs'), '')
    await mkdir(path.join(vendorRoot, 'typescript'), { recursive: true })
    await writeFile(
      path.join(vendorRoot, 'typescript/package.json'),
      JSON.stringify({ version: '5.9.3' }),
    )
    appPathHolder.current = vendorDir
    try {
      await writeFile(
        path.join(settingsDir, 'settings.json'),
        JSON.stringify({ 'js/ts.experimental.useTsgo': false }),
      )
      const spec = createTsServerSpecResolver(settingsDir)()
      expect(spec.kind).toBe('tsls')
      expect(spec.version).toBe('5.9.3')
    } finally {
      appPathHolder.current = appRoot
      await rm(vendorDir, { recursive: true, force: true })
    }
  })

  it('native spec carries the native-preview package version', async () => {
    await writeFile(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ 'js/ts.experimental.useTsgo': true }),
    )
    const spec = createTsServerSpecResolver(settingsDir)()
    expect(spec.kind).toBe('native')
    expect(spec.version).toContain('7.0.0-dev')
  })
})

describe('workspace settings layering', () => {
  let workspaceDir = ''

  beforeEach(async () => {
    settingsDir = await mkdtemp(path.join(tmpdir(), 'universe-editor-ts-server-pref-'))
    workspaceDir = await mkdtemp(path.join(tmpdir(), 'universe-editor-ts-server-ws-'))
    vi.stubEnv('UNIVERSE_TS_SERVER', '')
    vi.stubEnv('UNIVERSE_TSGO_BIN', '')
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(settingsDir, { recursive: true, force: true })
    await rm(workspaceDir, { recursive: true, force: true })
  })

  function layerBody(value: unknown): string {
    return JSON.stringify({ 'js/ts.experimental.useTsgo': value })
  }

  async function writeLayer(dir: '.universe-editor' | '.vscode', body: string): Promise<void> {
    await mkdir(path.join(workspaceDir, dir), { recursive: true })
    await writeFile(path.join(workspaceDir, dir, 'settings.json'), body)
  }

  async function writeUserSettings(body: string): Promise<void> {
    await writeFile(path.join(settingsDir, 'settings.json'), body)
  }

  it('workspace .universe-editor selects native', async () => {
    await writeLayer('.universe-editor', layerBody(true))
    const spec = createTsServerSpecResolver(settingsDir)(workspaceDir)
    expect(spec.kind).toBe('native')
  })

  it('workspace overrides user, in both directions', async () => {
    await writeUserSettings(layerBody(false))
    await writeLayer('.universe-editor', layerBody(true))
    expect(createTsServerSpecResolver(settingsDir)(workspaceDir).kind).toBe('native')

    await writeUserSettings(layerBody(true))
    await writeLayer('.universe-editor', layerBody(false))
    expect(createTsServerSpecResolver(settingsDir)(workspaceDir).kind).toBe('tsls')
  })

  it('.vscode settings apply when no .universe-editor layer exists', async () => {
    await writeLayer('.vscode', layerBody(true))
    expect(defaultTsServerPreference(settingsDir)(workspaceDir)).toEqual({
      value: 'native',
      source: 'vscode-workspace',
    })
  })

  it('.universe-editor overrides .vscode', async () => {
    await writeLayer('.vscode', layerBody(true))
    await writeLayer('.universe-editor', layerBody(false))
    expect(createTsServerSpecResolver(settingsDir)(workspaceDir).kind).toBe('tsls')
  })

  it('UNIVERSE_TS_SERVER still beats workspace settings', async () => {
    await writeLayer('.universe-editor', layerBody(true))
    vi.stubEnv('UNIVERSE_TS_SERVER', 'tsls')
    expect(createTsServerSpecResolver(settingsDir)(workspaceDir).kind).toBe('tsls')
  })

  it('an invalid workspace value falls through to the user layer', async () => {
    await writeLayer('.universe-editor', layerBody('v8-something'))
    await writeUserSettings(layerBody(false))
    expect(defaultTsServerPreference(settingsDir)(workspaceDir)).toEqual({
      value: 'tsls',
      source: 'user',
    })
  })

  it('workspace settings tolerate JSONC comments and trailing commas', async () => {
    await writeLayer(
      '.universe-editor',
      '{\n  // pick the Go native LSP\n  "js/ts.experimental.useTsgo": true,\n}\n',
    )
    expect(createTsServerSpecResolver(settingsDir)(workspaceDir).kind).toBe('native')
  })

  it('user settings.json tolerates JSONC comments (the migrated file carries one)', async () => {
    await writeUserSettings(
      '// User settings — migrated from previous storage on first launch.\n' + layerBody(true),
    )
    expect(createTsServerSpecResolver(settingsDir)().kind).toBe('native')
  })

  it('reports the winning source for each layer', async () => {
    expect(defaultTsServerPreference(settingsDir)(workspaceDir).source).toBe('default')
    await writeUserSettings(layerBody(false))
    expect(defaultTsServerPreference(settingsDir)(workspaceDir).source).toBe('user')
    await writeLayer('.universe-editor', layerBody(false))
    expect(defaultTsServerPreference(settingsDir)(workspaceDir).source).toBe('workspace')
    vi.stubEnv('UNIVERSE_TS_SERVER', 'tsls')
    expect(defaultTsServerPreference(settingsDir)(workspaceDir).source).toBe('env')
    vi.stubEnv('UNIVERSE_TSGO_BIN', '/custom/tsgo')
    expect(defaultTsServerPreference(settingsDir)(workspaceDir).source).toBe('binary-env')
  })
})

describe('packaged tsgo resolution', () => {
  const mockedApp = app as { isPackaged: boolean }
  const proc = process as NodeJS.Process & { resourcesPath?: string }
  const tsgoExe = process.platform === 'win32' ? 'tsgo.exe' : 'tsgo'
  let resourcesDir = ''

  beforeEach(async () => {
    settingsDir = await mkdtemp(path.join(tmpdir(), 'universe-editor-ts-server-pref-'))
    resourcesDir = await mkdtemp(path.join(tmpdir(), 'universe-editor-resources-'))
    mockedApp.isPackaged = true
    proc.resourcesPath = resourcesDir
  })

  afterEach(async () => {
    mockedApp.isPackaged = false
    Reflect.deleteProperty(proc, 'resourcesPath')
    await rm(settingsDir, { recursive: true, force: true })
    await rm(resourcesDir, { recursive: true, force: true })
  })

  it('resolves the staged tsgo exe and reads its version', async () => {
    await mkdir(path.join(resourcesDir, 'tsgo/lib'), { recursive: true })
    await writeFile(path.join(resourcesDir, 'tsgo/lib', tsgoExe), '')
    await writeFile(
      path.join(resourcesDir, 'tsgo/package.json'),
      JSON.stringify({ version: '7.0.0-dev.staged' }),
    )
    await writeFile(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ 'js/ts.experimental.useTsgo': true }),
    )
    const spec = createTsServerSpecResolver(settingsDir)()
    expect(spec.kind).toBe('native')
    if (spec.kind === 'native') {
      expect(spec.binary).toBe(path.join(resourcesDir, 'tsgo/lib', tsgoExe))
      expect(spec.version).toBe('7.0.0-dev.staged')
    }
  })

  it('falls back to tsls when the staged tsgo exe is missing', async () => {
    await writeFile(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ 'js/ts.experimental.useTsgo': true }),
    )
    const spec = createTsServerSpecResolver(settingsDir)()
    expect(spec.kind).toBe('tsls')
    if (spec.kind === 'tsls') {
      expect(spec.cli).toBe(
        path.join(
          resourcesDir,
          'typescript-language-server/node_modules/typescript-language-server/lib/cli.mjs',
        ),
      )
    }
  })
})
