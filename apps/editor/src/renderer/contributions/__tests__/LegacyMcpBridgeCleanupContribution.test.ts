/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  LegacyMcpBridgeCleanupContribution — the one-shot removal of the settings
 *  entry old MCP bridge extension versions wrote at activation. Only an exact
 *  shape match is removed; anything the user touched is preserved; the storage
 *  flag makes the cleanup idempotent across launches.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  ConfigurationService,
  ConfigurationTarget,
  Event,
  LogLevel,
  NullLogger,
  StorageScope,
  UriIdentityService,
  type ILogger,
  type ILoggerService,
  type IStorageService,
} from '@universe-editor/platform'
import type {
  IEnvironmentSnapshot,
  IEnvironmentSnapshotService,
} from '../../../shared/ipc/environmentSnapshotService.js'
import {
  isLegacyBridgeEntry,
  LEGACY_MCP_BRIDGE_CLEANED_KEY,
  LegacyMcpBridgeCleanupContribution,
} from '../LegacyMcpBridgeCleanupContribution.js'

const EXEC_PATH = 'C:\\App\\Universe Editor.exe'
const URI_IDENTITY = new UriIdentityService('win32')
const pathKey = (p: string): string => URI_IDENTITY.getPathComparisonKey(p)
const LEGACY_ENTRY = {
  command: EXEC_PATH,
  args: ['C:/exts/bridge/resources/bridge/bridge.mjs'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
}

class FakeStorage implements IStorageService {
  declare readonly _serviceBrand: undefined
  readonly store = new Map<string, unknown>()
  readonly onDidChangeWorkspaceScope = Event.None
  async get<T = unknown>(key: string, _scope?: StorageScope): Promise<T | undefined> {
    return this.store.get(key) as T | undefined
  }
  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this.store.delete(key)
  }
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

const envSnapshot: IEnvironmentSnapshotService = {
  async getSnapshot(): Promise<IEnvironmentSnapshot> {
    return { userHome: '/h', cwd: '/', execPath: EXEC_PATH, env: {} }
  },
} as IEnvironmentSnapshotService

async function runCleanup(
  userValue: unknown,
  storage = new FakeStorage(),
): Promise<{ config: ConfigurationService; storage: FakeStorage }> {
  const config = new ConfigurationService()
  if (userValue !== undefined) config.update('acp.mcpServers', userValue, ConfigurationTarget.User)
  new LegacyMcpBridgeCleanupContribution(
    config,
    storage,
    envSnapshot,
    URI_IDENTITY,
    new StubLoggerService(),
  )
  await vi.waitFor(() => {
    if (!storage.store.has(LEGACY_MCP_BRIDGE_CLEANED_KEY)) throw new Error('not settled')
  })
  return { config, storage }
}

function userMcpServers(config: ConfigurationService): Record<string, unknown> {
  return (config.getLayerSnapshot(ConfigurationTarget.User)['acp.mcpServers'] ?? {}) as Record<
    string,
    unknown
  >
}

describe('isLegacyBridgeEntry', () => {
  it('matches the exact legacy shape, normalizing slashes and case', () => {
    expect(isLegacyBridgeEntry(LEGACY_ENTRY, EXEC_PATH, pathKey)).toBe(true)
    expect(
      isLegacyBridgeEntry(
        {
          command: 'c:/app/universe editor.exe',
          args: ['C:\\exts\\bridge\\resources\\bridge\\bridge.mjs'],
          env: { ELECTRON_RUN_AS_NODE: '1' },
        },
        EXEC_PATH,
        pathKey,
      ),
    ).toBe(true)
  })

  it.each([
    ['extra key means user-touched', { ...LEGACY_ENTRY, disabled: true }],
    ['different command', { ...LEGACY_ENTRY, command: 'node' }],
    ['multiple args', { ...LEGACY_ENTRY, args: [LEGACY_ENTRY.args[0], '--flag'] }],
    ['wrong arg suffix', { ...LEGACY_ENTRY, args: ['C:/somewhere/else.mjs'] }],
    ['missing env', { command: EXEC_PATH, args: LEGACY_ENTRY.args }],
    ['extra env key', { ...LEGACY_ENTRY, env: { ELECTRON_RUN_AS_NODE: '1', FOO: 'x' } }],
    ['wrong env value', { ...LEGACY_ENTRY, env: { ELECTRON_RUN_AS_NODE: '0' } }],
    ['not an object', 'universe-editor'],
    ['null', null],
  ])('rejects: %s', (_label, entry) => {
    expect(isLegacyBridgeEntry(entry, EXEC_PATH, pathKey)).toBe(false)
  })
})

describe('LegacyMcpBridgeCleanupContribution', () => {
  it('removes a shape-matching entry from the User layer and sets the flag', async () => {
    const { config, storage } = await runCleanup({
      'universe-editor': LEGACY_ENTRY,
      other: { command: 'node' },
    })
    expect(userMcpServers(config)).toEqual({ other: { command: 'node' } })
    expect(storage.store.get(LEGACY_MCP_BRIDGE_CLEANED_KEY)).toBe(true)
  })

  it('keeps a user-modified entry, still sets the flag', async () => {
    const modified = { ...LEGACY_ENTRY, disabled: true }
    const { config, storage } = await runCleanup({ 'universe-editor': modified })
    expect(userMcpServers(config)).toEqual({ 'universe-editor': modified })
    expect(storage.store.get(LEGACY_MCP_BRIDGE_CLEANED_KEY)).toBe(true)
  })

  it('sets the flag when there is no entry at all', async () => {
    const { config, storage } = await runCleanup(undefined)
    expect(userMcpServers(config)).toEqual({})
    expect(storage.store.get(LEGACY_MCP_BRIDGE_CLEANED_KEY)).toBe(true)
  })

  it('does nothing once the flag is set (idempotent across launches)', async () => {
    const storage = new FakeStorage()
    storage.store.set(LEGACY_MCP_BRIDGE_CLEANED_KEY, true)
    const { config } = await runCleanup({ 'universe-editor': LEGACY_ENTRY }, storage)
    expect(userMcpServers(config)).toEqual({ 'universe-editor': LEGACY_ENTRY })
  })
})
