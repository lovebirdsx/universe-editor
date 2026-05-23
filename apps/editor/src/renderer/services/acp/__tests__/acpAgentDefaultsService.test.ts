/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpAgentDefaultsService.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Event,
  LogLevel,
  NoopTelemetryService,
  NullLogger,
  StorageScope,
  type ILogger,
  type ILoggerService,
  type IStorageService,
} from '@universe-editor/platform'
import { AcpAgentDefaultsService } from '../acpAgentDefaultsService.js'

class FakeStorage implements IStorageService {
  declare readonly _serviceBrand: undefined
  readonly store = new Map<string, unknown>()
  readonly setCalls: Array<{ key: string; value: unknown; scope?: StorageScope }> = []
  readonly onDidChangeWorkspaceScope = Event.None
  async get<T = unknown>(key: string, _scope?: StorageScope): Promise<T | undefined> {
    return this.store.get(key) as T | undefined
  }
  async set(key: string, value: unknown, scope?: StorageScope): Promise<void> {
    this.store.set(key, value)
    this.setCalls.push({ key, value, ...(scope !== undefined ? { scope } : {}) })
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

function makeService(storage: FakeStorage = new FakeStorage()): {
  svc: AcpAgentDefaultsService
  storage: FakeStorage
} {
  const svc = new AcpAgentDefaultsService(
    storage,
    new NoopTelemetryService(),
    new StubLoggerService(),
  )
  return { svc, storage }
}

async function flushWrite(): Promise<void> {
  await new Promise((r) => setTimeout(r, 130))
}

describe('AcpAgentDefaultsService — get / set', () => {
  let svc: AcpAgentDefaultsService
  beforeEach(() => {
    svc = makeService().svc
  })
  afterEach(() => {
    svc.dispose()
  })

  it('returns an empty object for unknown agentIds', async () => {
    await svc.initialize()
    expect(svc.getDefaults('nope')).toEqual({})
  })

  it('stores a fresh default and exposes it via getDefaults', async () => {
    await svc.initialize()
    svc.setDefault('claude-code', 'model', 'claude-sonnet-4-6')
    expect(svc.getDefaults('claude-code')).toEqual({ model: 'claude-sonnet-4-6' })
  })

  it('merges defaults per agent, preserving siblings', async () => {
    await svc.initialize()
    svc.setDefault('claude-code', 'model', 'A')
    svc.setDefault('claude-code', 'thought_level', 'high')
    expect(svc.getDefaults('claude-code')).toEqual({ model: 'A', thought_level: 'high' })
  })

  it('keeps agents isolated from each other', async () => {
    await svc.initialize()
    svc.setDefault('claude-code', 'model', 'A')
    svc.setDefault('codex', 'model', 'B')
    expect(svc.getDefaults('claude-code')).toEqual({ model: 'A' })
    expect(svc.getDefaults('codex')).toEqual({ model: 'B' })
  })

  it('overwrites the same key without duplicating it', async () => {
    await svc.initialize()
    svc.setDefault('claude-code', 'model', 'A')
    svc.setDefault('claude-code', 'model', 'B')
    expect(svc.getDefaults('claude-code')).toEqual({ model: 'B' })
  })

  it('returns a clone — mutating the returned object does not affect state', async () => {
    await svc.initialize()
    svc.setDefault('claude-code', 'model', 'A')
    const copy = svc.getDefaults('claude-code') as Record<string, string>
    copy['model'] = 'mutated'
    expect(svc.getDefaults('claude-code')).toEqual({ model: 'A' })
  })

  it('publishes via the defaults observable', async () => {
    await svc.initialize()
    expect(svc.defaults.get()).toEqual({})
    svc.setDefault('a', 'k', 'v')
    expect(svc.defaults.get()).toEqual({ a: { k: 'v' } })
  })
})

describe('AcpAgentDefaultsService — persistence', () => {
  let svc: AcpAgentDefaultsService
  let storage: FakeStorage
  beforeEach(() => {
    const made = makeService()
    svc = made.svc
    storage = made.storage
  })
  afterEach(() => {
    svc.dispose()
  })

  it('writes after a debounce window with the right scope + schemaVersion', async () => {
    await svc.initialize()
    svc.setDefault('claude-code', 'model', 'A')
    expect(storage.setCalls.length).toBe(0)
    await flushWrite()
    expect(storage.setCalls.length).toBe(1)
    const call = storage.setCalls[0]!
    expect(call.key).toBe('acp.agentDefaults')
    expect(call.scope).toBe(StorageScope.GLOBAL)
    const persisted = call.value as { schemaVersion: number; defaults: unknown }
    expect(persisted.schemaVersion).toBe(1)
    expect(persisted.defaults).toEqual({ 'claude-code': { model: 'A' } })
  })

  it('coalesces a burst of writes into a single set() call', async () => {
    await svc.initialize()
    svc.setDefault('a', 'k1', 'v1')
    svc.setDefault('a', 'k2', 'v2')
    svc.setDefault('b', 'k1', 'v3')
    await flushWrite()
    expect(storage.setCalls.length).toBe(1)
  })

  it('skips the write when the same value is set again', async () => {
    await svc.initialize()
    svc.setDefault('a', 'k', 'v')
    await flushWrite()
    const before = storage.setCalls.length
    svc.setDefault('a', 'k', 'v')
    await flushWrite()
    expect(storage.setCalls.length).toBe(before)
  })

  it('hydrates from storage on initialize()', async () => {
    storage.store.set('acp.agentDefaults', {
      schemaVersion: 1,
      defaults: { 'claude-code': { model: 'A', thought_level: 'high' } },
    })
    await svc.initialize()
    expect(svc.getDefaults('claude-code')).toEqual({ model: 'A', thought_level: 'high' })
  })

  it('ignores unknown schemaVersion (fails closed, empty map)', async () => {
    storage.store.set('acp.agentDefaults', {
      schemaVersion: 999,
      defaults: { a: { k: 'v' } },
    })
    await svc.initialize()
    expect(svc.getDefaults('a')).toEqual({})
  })

  it('rejects malformed defaults (non-string values)', async () => {
    storage.store.set('acp.agentDefaults', {
      schemaVersion: 1,
      defaults: { a: { k: 123 } },
    })
    await svc.initialize()
    expect(svc.getDefaults('a')).toEqual({})
  })

  it('initialize() is idempotent — second call does not re-read', async () => {
    await svc.initialize()
    storage.store.set('acp.agentDefaults', {
      schemaVersion: 1,
      defaults: { late: { k: 'v' } },
    })
    await svc.initialize()
    expect(svc.getDefaults('late')).toEqual({})
  })
})
