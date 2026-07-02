/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpSessionFilterService.ts
 *
 *  Covers the funnel-menu state: sort mode, agent/status excludes, reset,
 *  isFilterDefault derivation, the statusBucketFor mapping, and the GLOBAL
 *  storage round-trip (persist + reload).
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest'
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
import { AcpSessionFilterService, statusBucketFor } from '../acpSessionFilterService.js'

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

function make(storage = new FakeStorage()) {
  const service = new AcpSessionFilterService(
    storage,
    new NoopTelemetryService(),
    new StubLoggerService(),
  )
  return { service, storage }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('statusBucketFor', () => {
  it('folds display statuses into coarse buckets', () => {
    expect(statusBucketFor('running')).toBe('in_progress')
    expect(statusBucketFor('connecting')).toBe('in_progress')
    expect(statusBucketFor('ask')).toBe('input_needed')
    expect(statusBucketFor('errored')).toBe('failed')
    expect(statusBucketFor('idle')).toBe('completed')
    expect(statusBucketFor('closed')).toBe('completed')
  })
})

describe('AcpSessionFilterService', () => {
  let service: AcpSessionFilterService

  beforeEach(() => {
    service = make().service
  })

  it('defaults to updated sort with no excludes', () => {
    expect(service.sortMode.get()).toBe('updated')
    expect(service.excludedAgentIds.get().size).toBe(0)
    expect(service.excludedStatuses.get().size).toBe(0)
    expect(service.isFilterDefault.get()).toBe(true)
  })

  it('setSortMode flips default flag', () => {
    service.setSortMode('created')
    expect(service.sortMode.get()).toBe('created')
    expect(service.isFilterDefault.get()).toBe(false)
    service.setSortMode('updated')
    expect(service.isFilterDefault.get()).toBe(true)
  })

  it('toggleAgent adds then removes from excludes', () => {
    service.toggleAgent('codex')
    expect(service.excludedAgentIds.get().has('codex')).toBe(true)
    expect(service.isFilterDefault.get()).toBe(false)
    service.toggleAgent('codex')
    expect(service.excludedAgentIds.get().has('codex')).toBe(false)
    expect(service.isFilterDefault.get()).toBe(true)
  })

  it('toggleStatus adds then removes from excludes', () => {
    service.toggleStatus('failed')
    expect(service.excludedStatuses.get().has('failed')).toBe(true)
    service.toggleStatus('failed')
    expect(service.excludedStatuses.get().has('failed')).toBe(false)
  })

  it('resetFilters restores defaults', () => {
    service.setSortMode('created')
    service.toggleAgent('claude-code')
    service.toggleStatus('in_progress')
    expect(service.isFilterDefault.get()).toBe(false)
    service.resetFilters()
    expect(service.sortMode.get()).toBe('updated')
    expect(service.excludedAgentIds.get().size).toBe(0)
    expect(service.excludedStatuses.get().size).toBe(0)
    expect(service.isFilterDefault.get()).toBe(true)
  })

  it('closeSearch clears query but leaves filters intact', () => {
    service.setSortMode('created')
    service.setQuery('foo')
    service.openSearch()
    service.closeSearch()
    expect(service.query.get()).toBe('')
    expect(service.searchOpen.get()).toBe(false)
    expect(service.sortMode.get()).toBe('created')
  })

  it('persists filter state and reloads it', async () => {
    const storage = new FakeStorage()
    const a = make(storage).service
    a.setSortMode('created')
    a.toggleAgent('codex')
    a.toggleStatus('failed')
    await flush() // let the 100ms debounced write fire
    await new Promise((r) => setTimeout(r, 150))

    const b = make(storage).service
    await b.initialize()
    expect(b.sortMode.get()).toBe('created')
    expect(b.excludedAgentIds.get().has('codex')).toBe(true)
    expect(b.excludedStatuses.get().has('failed')).toBe(true)
    expect(b.isFilterDefault.get()).toBe(false)
  })

  it('ignores persisted state with a mismatched schema version', async () => {
    const storage = new FakeStorage()
    await storage.set('acp.sessionFilter', { schemaVersion: 999, sortMode: 'created' })
    const b = make(storage).service
    await b.initialize()
    expect(b.sortMode.get()).toBe('updated')
  })
})
