/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpCompactionStats.ts
 *
 *  Exercises per-agent recording (median estimate, rolling window, failed-run
 *  exclusion is enforced by the caller — here we only test valid samples) and
 *  the storage round-trip (persist + restore, foreign schema rejection).
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
import { AcpCompactionStatsService } from '../acpCompactionStats.js'

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

function makeService(storage: FakeStorage = new FakeStorage()): AcpCompactionStatsService {
  return new AcpCompactionStatsService(storage, new NoopTelemetryService(), new StubLoggerService())
}

/** Drain the 100ms debounce + the async set() microtask. */
async function flushWrite(): Promise<void> {
  await new Promise((r) => setTimeout(r, 130))
}

describe('AcpCompactionStatsService — recording & estimation', () => {
  let svc: AcpCompactionStatsService
  beforeEach(() => {
    svc = makeService()
  })
  afterEach(() => svc.dispose())

  it('returns undefined with no samples', () => {
    expect(svc.getExpectedDurationMs('claude-code')).toBeUndefined()
  })

  it('returns the single sample as the estimate', () => {
    svc.record('claude-code', 5000)
    expect(svc.getExpectedDurationMs('claude-code')).toBe(5000)
  })

  it('uses the median (odd count) — robust to a single slow outlier', () => {
    svc.record('claude-code', 4000)
    svc.record('claude-code', 5000)
    svc.record('claude-code', 60000) // outlier: a stall shouldn't dominate
    expect(svc.getExpectedDurationMs('claude-code')).toBe(5000)
  })

  it('averages the two middle samples on an even count', () => {
    svc.record('claude-code', 4000)
    svc.record('claude-code', 6000)
    expect(svc.getExpectedDurationMs('claude-code')).toBe(5000)
  })

  it('buckets samples per agent', () => {
    svc.record('claude-code', 5000)
    svc.record('codex', 12000)
    expect(svc.getExpectedDurationMs('claude-code')).toBe(5000)
    expect(svc.getExpectedDurationMs('codex')).toBe(12000)
  })

  it('ignores non-positive or non-finite durations', () => {
    svc.record('claude-code', 0)
    svc.record('claude-code', -100)
    svc.record('claude-code', Number.NaN)
    expect(svc.getExpectedDurationMs('claude-code')).toBeUndefined()
  })

  it('keeps only the most recent MAX_SAMPLES (window drops the oldest)', () => {
    // 25 samples: the first 5 (all 1000) age out, leaving 20 at 9000 → median 9000.
    for (let i = 0; i < 5; i++) svc.record('claude-code', 1000)
    for (let i = 0; i < 20; i++) svc.record('claude-code', 9000)
    expect(svc.getExpectedDurationMs('claude-code')).toBe(9000)
  })
})

describe('AcpCompactionStatsService — persistence', () => {
  it('persists samples and restores them into a fresh service', async () => {
    const storage = new FakeStorage()
    const a = makeService(storage)
    a.record('claude-code', 4000)
    a.record('claude-code', 6000)
    await flushWrite()
    a.dispose()

    const b = makeService(storage)
    await b.initialize()
    expect(b.getExpectedDurationMs('claude-code')).toBe(5000)
    b.dispose()
  })

  it('flushes pending samples synchronously on dispose', async () => {
    const storage = new FakeStorage()
    const svc = makeService(storage)
    svc.record('claude-code', 7000)
    svc.dispose() // must flush the debounced write before teardown
    await Promise.resolve()
    expect(storage.store.get('acp.compactionStats')).toMatchObject({
      schemaVersion: 1,
      samples: { 'claude-code': [7000] },
    })
  })

  it('ignores a stored payload with a foreign schemaVersion', async () => {
    const storage = new FakeStorage()
    storage.store.set('acp.compactionStats', {
      schemaVersion: 999,
      samples: { 'claude-code': [5000] },
    })
    const svc = makeService(storage)
    await svc.initialize()
    expect(svc.getExpectedDurationMs('claude-code')).toBeUndefined()
    svc.dispose()
  })

  it('drops corrupt sample values on load', async () => {
    const storage = new FakeStorage()
    storage.store.set('acp.compactionStats', {
      schemaVersion: 1,
      samples: { 'claude-code': [5000, -1, 'x', null, 7000] },
    })
    const svc = makeService(storage)
    await svc.initialize()
    // Only 5000 and 7000 survive → median 6000.
    expect(svc.getExpectedDurationMs('claude-code')).toBe(6000)
    svc.dispose()
  })
})
