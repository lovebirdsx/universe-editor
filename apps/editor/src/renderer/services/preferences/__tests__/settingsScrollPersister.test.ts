import { afterEach, describe, expect, it, vi } from 'vitest'
import { Event, IStorageService } from '@universe-editor/platform'
import { SettingsScrollPersister } from '../settingsScrollPersister.js'

class FakeStorage implements IStorageService {
  declare readonly _serviceBrand: undefined
  readonly onDidChangeWorkspaceScope = Event.None
  store = new Map<string, unknown>()
  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined
  }
  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this.store.delete(key)
  }
}

describe('SettingsScrollPersister', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('load returns undefined before anything is saved', () => {
    const p = new SettingsScrollPersister(new FakeStorage())
    expect(p.load('k')).toBeUndefined()
  })

  it('save is synchronously readable via load', () => {
    const p = new SettingsScrollPersister(new FakeStorage())
    p.save('k', 120)
    expect(p.load('k')).toBe(120)
  })

  it('mirrors saves to storage after a debounce', async () => {
    vi.useFakeTimers()
    const storage = new FakeStorage()
    const p = new SettingsScrollPersister(storage)
    p.save('a', 10)
    p.save('b', 20)
    p.save('a', 30)
    expect(storage.store.size).toBe(0)

    await vi.advanceTimersByTimeAsync(250)
    expect(storage.store.get('a')).toBe(30)
    expect(storage.store.get('b')).toBe(20)
  })

  it('prefetch hydrates positive positions from storage', async () => {
    const storage = new FakeStorage()
    storage.store.set('x', 55)
    storage.store.set('zero', 0)
    const p = new SettingsScrollPersister(storage)

    await p.prefetch(['x', 'zero', 'missing'])
    expect(p.load('x')).toBe(55)
    expect(p.load('zero')).toBeUndefined()
    expect(p.load('missing')).toBeUndefined()
  })
})
