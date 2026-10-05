/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpCompactionStats.ts
 *
 *  Exercises per-agent-and-model recording (median estimate, rolling window,
 *  model-unknown fallback, id normalization) and the storage round-trip
 *  (persist + restore, foreign schema rejection). Failed-run exclusion is
 *  enforced by the caller — here we only test valid samples.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Event,
  NoopTelemetryService,
  StorageScope,
  type IStorageService,
} from '@universe-editor/platform'
import { AcpCompactionStatsService } from '../acpCompactionStats.js'
import { StubLoggerService } from '../../../../__tests__/_helpers/stubLoggerService.js'

const SONNET = 'claude-sonnet-4-6'
const OPUS = 'claude-opus-4-8'

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
    expect(svc.getExpectedDurationMs('claude-code', undefined)).toBeUndefined()
  })

  it('returns the single sample as the estimate', () => {
    svc.record('claude-code', 5000, undefined)
    expect(svc.getExpectedDurationMs('claude-code', undefined)).toBe(5000)
  })

  it('uses the median (odd count) — robust to a single slow outlier', () => {
    svc.record('claude-code', 4000, undefined)
    svc.record('claude-code', 5000, undefined)
    svc.record('claude-code', 60000, undefined) // outlier: a stall shouldn't dominate
    expect(svc.getExpectedDurationMs('claude-code', undefined)).toBe(5000)
  })

  it('averages the two middle samples on an even count', () => {
    svc.record('claude-code', 4000, undefined)
    svc.record('claude-code', 6000, undefined)
    expect(svc.getExpectedDurationMs('claude-code', undefined)).toBe(5000)
  })

  it('buckets samples per agent', () => {
    svc.record('claude-code', 5000, undefined)
    svc.record('codex', 12000, undefined)
    expect(svc.getExpectedDurationMs('claude-code', undefined)).toBe(5000)
    expect(svc.getExpectedDurationMs('codex', undefined)).toBe(12000)
  })

  it('ignores non-positive or non-finite durations', () => {
    svc.record('claude-code', 0, undefined)
    svc.record('claude-code', -100, undefined)
    svc.record('claude-code', Number.NaN, undefined)
    expect(svc.getExpectedDurationMs('claude-code', undefined)).toBeUndefined()
  })

  it('keeps only the most recent MAX_SAMPLES (window drops the oldest)', () => {
    // 25 samples: the first 5 (all 1000) age out, leaving 20 at 9000 → median 9000.
    for (let i = 0; i < 5; i++) svc.record('claude-code', 1000, undefined)
    for (let i = 0; i < 20; i++) svc.record('claude-code', 9000, undefined)
    expect(svc.getExpectedDurationMs('claude-code', undefined)).toBe(9000)
  })
})

describe('AcpCompactionStatsService — model buckets', () => {
  let svc: AcpCompactionStatsService
  beforeEach(() => {
    svc = makeService()
  })
  afterEach(() => svc.dispose())

  it('keeps different models of the same agent in separate buckets', () => {
    svc.record('claude-code', 5000, SONNET)
    svc.record('claude-code', 20000, OPUS)
    expect(svc.getExpectedDurationMs('claude-code', SONNET)).toBe(5000)
    expect(svc.getExpectedDurationMs('claude-code', OPUS)).toBe(20000)
  })

  it('does not leak another model of the same agent into an unsampled model', () => {
    svc.record('claude-code', 8000, SONNET)
    expect(svc.getExpectedDurationMs('claude-code', OPUS)).toBeUndefined()
  })

  it('never writes a known model into the model-unknown bucket', () => {
    svc.record('claude-code', 8000, SONNET)
    expect(svc.getExpectedDurationMs('claude-code', undefined)).toBeUndefined()
  })

  it('bridges from the model-unknown bucket while a model has no samples', () => {
    svc.record('claude-code', 9000, undefined)
    expect(svc.getExpectedDurationMs('claude-code', SONNET)).toBe(9000)
  })

  it('prefers the exact model bucket over the model-unknown bridge', () => {
    svc.record('claude-code', 9000, undefined)
    svc.record('claude-code', 3000, SONNET)
    expect(svc.getExpectedDurationMs('claude-code', SONNET)).toBe(3000)
  })

  it('treats a blank model id as the model-unknown bucket', () => {
    svc.record('claude-code', 7000, '   ')
    expect(svc.getExpectedDurationMs('claude-code', undefined)).toBe(7000)
    expect(svc.getExpectedDurationMs('claude-code', SONNET)).toBe(7000)
  })

  it('folds dotted, hyphenated and differently-cased spellings of one model', () => {
    svc.record('claude-code', 5000, 'Claude-Opus-4.8')
    expect(svc.getExpectedDurationMs('claude-code', OPUS)).toBe(5000)
  })

  it('keeps the [1m] lane in its own bucket', () => {
    // The lane is a different workload (≈5x the tokens summarized), not a
    // spelling variant, so it must not fold into the bare model's bucket.
    svc.record('claude-code', 60_000, `${OPUS}[1m]`)
    svc.record('claude-code', 8000, OPUS)
    expect(svc.getExpectedDurationMs('claude-code', `${OPUS}[1m]`)).toBe(60_000)
    expect(svc.getExpectedDurationMs('claude-code', OPUS)).toBe(8000)
  })
})

describe('AcpCompactionStatsService — persistence', () => {
  it('persists samples and restores them into a fresh service', async () => {
    const storage = new FakeStorage()
    const a = makeService(storage)
    a.record('claude-code', 4000, SONNET)
    a.record('claude-code', 6000, SONNET)
    a.record('claude-code', 20000, OPUS)
    a.record('claude-code', 9000, undefined)
    await flushWrite()
    a.dispose()

    const b = makeService(storage)
    await b.initialize()
    expect(b.getExpectedDurationMs('claude-code', SONNET)).toBe(5000)
    expect(b.getExpectedDurationMs('claude-code', OPUS)).toBe(20000)
    expect(b.getExpectedDurationMs('claude-code', undefined)).toBe(9000)
    b.dispose()
  })

  it('round-trips composite bucket keys through JSON', async () => {
    const storage = new FakeStorage()
    const a = makeService(storage)
    a.record('claude-code', 20_000, `${OPUS}[1m]`)
    a.dispose() // flush the debounced write
    await Promise.resolve()

    // The real IStorageService serializes through JSON, which escapes the key
    // separator; exercise that hop rather than trusting the in-memory map.
    storage.store.set(
      'acp.compactionStats',
      JSON.parse(JSON.stringify(storage.store.get('acp.compactionStats'))),
    )

    const b = makeService(storage)
    await b.initialize()
    expect(b.getExpectedDurationMs('claude-code', `${OPUS}[1m]`)).toBe(20_000)
    expect(b.getExpectedDurationMs('claude-code', OPUS)).toBeUndefined()
    b.dispose()
  })

  it('flushes pending samples synchronously on dispose', async () => {
    const storage = new FakeStorage()
    const svc = makeService(storage)
    svc.record('claude-code', 7000, undefined)
    svc.dispose() // must flush the debounced write before teardown
    await Promise.resolve()
    // An unknown model keeps the bare-agentId key — the layout v1 data already has.
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
    expect(svc.getExpectedDurationMs('claude-code', undefined)).toBeUndefined()
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
    expect(svc.getExpectedDurationMs('claude-code', undefined)).toBe(6000)
    svc.dispose()
  })

  it('drops corrupt sample values in a composite-key bucket too', async () => {
    const storage = new FakeStorage()
    const svc = makeService(storage)
    svc.record('claude-code', 5000, SONNET)
    svc.dispose()
    await Promise.resolve()
    const raw = storage.store.get('acp.compactionStats') as { samples: Record<string, unknown> }
    const key = Object.keys(raw.samples)[0]!
    // Same payload, one poisoned value — the loader filters by value, not by key.
    raw.samples[key] = [4000, -1, 'x', 8000]
    const reloaded = makeService(storage)
    await reloaded.initialize()
    expect(reloaded.getExpectedDurationMs('claude-code', SONNET)).toBe(6000)
    reloaded.dispose()
  })

  it('reads v1 samples as the model-unknown bridge', async () => {
    // v1 wrote bare-agentId keys only; those stay meaningful (and useful) as the
    // cold-start bridge, which is why the schema version is unchanged.
    const storage = new FakeStorage()
    storage.store.set('acp.compactionStats', {
      schemaVersion: 1,
      samples: { 'claude-code': [5000, 7000] },
    })
    const svc = makeService(storage)
    await svc.initialize()
    expect(svc.getExpectedDurationMs('claude-code', SONNET)).toBe(6000)
    svc.dispose()
  })
})
