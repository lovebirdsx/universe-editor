import { describe, expect, it } from 'vitest'
import {
  ConfigurationService,
  ConfigurationTarget,
  IConfigurationService,
  IStorageService,
  InstantiationService,
  ServiceCollection,
} from '@universe-editor/platform'
import { UserSettingsSync, USER_SETTINGS_KEY } from '../UserSettingsSync.js'

class FakeStorage implements IStorageService {
  declare readonly _serviceBrand: undefined
  store = new Map<string, unknown>()
  setCalls: Array<{ key: string; value: unknown }> = []
  preset(key: string, value: unknown) {
    this.store.set(key, value)
  }
  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined
  }
  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, value)
    this.setCalls.push({ key, value })
  }
}

function makeInstance(storage: FakeStorage): {
  sync: UserSettingsSync
  config: ConfigurationService
} {
  const config = new ConfigurationService()
  const services = new ServiceCollection()
  services.set(IConfigurationService, config)
  services.set(IStorageService, storage)
  const inst = new InstantiationService(services)
  const sync = inst.createInstance(UserSettingsSync)
  return { sync, config }
}

describe('UserSettingsSync', () => {
  it('initialize() loads stored user settings into the User layer', async () => {
    const storage = new FakeStorage()
    storage.preset(USER_SETTINGS_KEY, { 'editor.fontSize': 16, 'workbench.colorTheme': 'light' })
    const { sync, config } = makeInstance(storage)

    await sync.initialize()
    expect(config.get('editor.fontSize')).toBe(16)
    expect(config.get('workbench.colorTheme')).toBe('light')
    sync.dispose()
    config.dispose()
  })

  it('initialize() falls back to {} when storage has no entry', async () => {
    const storage = new FakeStorage()
    const { sync, config } = makeInstance(storage)
    await sync.initialize()
    expect(config.get('anything')).toBeUndefined()
    sync.dispose()
    config.dispose()
  })

  it('User-layer update is persisted to storage', async () => {
    const storage = new FakeStorage()
    const { sync, config } = makeInstance(storage)
    await sync.initialize()

    config.update('editor.fontSize', 18, ConfigurationTarget.User)
    expect(storage.setCalls).toHaveLength(1)
    expect(storage.setCalls[0]?.key).toBe(USER_SETTINGS_KEY)
    expect(storage.setCalls[0]?.value).toEqual({ 'editor.fontSize': 18 })
    sync.dispose()
    config.dispose()
  })

  it('Memory-target update also triggers storage write (User layer unchanged but snapshot still written)', async () => {
    // The current sync is naive: it writes on EVERY change event. That is OK
    // because the snapshot is the User layer only; a Memory write fires the
    // event but the persisted payload stays correct.
    const storage = new FakeStorage()
    const { sync, config } = makeInstance(storage)
    await sync.initialize()

    config.update('foo', 'bar', ConfigurationTarget.Memory)
    expect(storage.setCalls).toHaveLength(1)
    expect(storage.setCalls[0]?.value).toEqual({})
    sync.dispose()
    config.dispose()
  })

  it('multiple updates are each persisted', async () => {
    const storage = new FakeStorage()
    const { sync, config } = makeInstance(storage)
    await sync.initialize()

    config.update('a', 1, ConfigurationTarget.User)
    config.update('b', 2, ConfigurationTarget.User)
    expect(storage.setCalls).toHaveLength(2)
    expect(storage.setCalls[1]?.value).toEqual({ a: 1, b: 2 })
    sync.dispose()
    config.dispose()
  })

  it('after dispose, further updates do not write to storage', async () => {
    const storage = new FakeStorage()
    const { sync, config } = makeInstance(storage)
    await sync.initialize()
    sync.dispose()

    storage.setCalls.length = 0
    config.update('x', 1, ConfigurationTarget.User)
    expect(storage.setCalls).toHaveLength(0)
    config.dispose()
  })
})
