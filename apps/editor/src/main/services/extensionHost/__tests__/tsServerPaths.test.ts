/*---------------------------------------------------------------------------------------------
 *  Tests for the TS-server preference chain (binary env > selection env >
 *  settings.json `typescript.server.implementation` > tsls default) and the
 *  native-binary resolver. Electron is mocked: resolveTsServerPaths walks up
 *  from app.getAppPath() and resolveNativePreviewBinary needs no Electron at
 *  all, but the module imports `app` at the top level.
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const appRoot = path.resolve(import.meta.dirname, '../../../../../../..')

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => appRoot,
    getPath: () => '',
  },
}))

const { createTsServerSpecResolver } = await import('../tsServerPaths.js')
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
      JSON.stringify({ 'typescript.server.implementation': 'native' }),
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
      JSON.stringify({ 'typescript.server.implementation': 'tsls' }),
    )
    expect(createTsServerSpecResolver(settingsDir)().kind).toBe('tsls')
  })

  it('falls back to the shared default for an unknown settings value', async () => {
    await writeFile(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ 'typescript.server.implementation': 'v8-something' }),
    )
    expect(createTsServerSpecResolver(settingsDir)().kind).toBe(DEFAULT_TS_SERVER_IMPLEMENTATION)
  })

  it('UNIVERSE_TS_SERVER beats settings.json', async () => {
    await writeFile(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ 'typescript.server.implementation': 'tsls' }),
    )
    vi.stubEnv('UNIVERSE_TS_SERVER', 'native')
    expect(createTsServerSpecResolver(settingsDir)().kind).toBe('native')
  })

  it('UNIVERSE_TSGO_BIN is the explicit binary override', async () => {
    await writeFile(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ 'typescript.server.implementation': 'tsls' }),
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
      JSON.stringify({ 'typescript.server.implementation': 'tsls' }),
    )
    expect(resolve().kind).toBe('tsls')
  })

  it('tsls spec carries the typescript package version', async () => {
    await writeFile(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ 'typescript.server.implementation': 'tsls' }),
    )
    const spec = createTsServerSpecResolver(settingsDir)()
    expect(spec.kind).toBe('tsls')
    expect(spec.version).toMatch(/^[0-9]+.[0-9]+.[0-9]+/)
  })

  it('native spec carries the native-preview package version', async () => {
    await writeFile(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ 'typescript.server.implementation': 'native' }),
    )
    const spec = createTsServerSpecResolver(settingsDir)()
    expect(spec.kind).toBe('native')
    expect(spec.version).toContain('7.0.0-dev')
  })
})
