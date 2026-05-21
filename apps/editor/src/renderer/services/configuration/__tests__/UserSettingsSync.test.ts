import { describe, expect, it } from 'vitest'
import {
  ConfigurationService,
  ConfigurationTarget,
  Emitter,
  Event,
  IConfigurationService,
  IStorageService,
  IUserDataFilesService,
  InstantiationService,
  ServiceCollection,
  URI,
  UserDataFile,
  type UriComponents,
} from '@universe-editor/platform'
import { UserSettingsSync, USER_SETTINGS_KEY } from '../UserSettingsSync.js'

class FakeStorage implements IStorageService {
  declare readonly _serviceBrand: undefined
  store = new Map<string, unknown>()
  setCalls: Array<{ key: string; value: unknown }> = []
  readonly onDidChangeWorkspaceScope = Event.None
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
  async remove(key: string): Promise<void> {
    this.store.delete(key)
  }
}

class FakeUserData implements IUserDataFilesService {
  declare readonly _serviceBrand: undefined
  files = new Map<UserDataFile, string>()
  writeCalls: Array<{ file: UserDataFile; content: string }> = []
  setValueCalls: Array<{ file: UserDataFile; path: readonly (string | number)[]; value: unknown }> =
    []
  private readonly _emitter = new Emitter<UserDataFile>()
  readonly onDidChangeFile = this._emitter.event

  async read(file: UserDataFile): Promise<string> {
    return this.files.get(file) ?? ''
  }
  async write(file: UserDataFile, content: string): Promise<void> {
    this.files.set(file, content)
    this.writeCalls.push({ file, content })
  }
  async setValue(
    file: UserDataFile,
    path: readonly (string | number)[],
    value: unknown,
  ): Promise<boolean> {
    this.setValueCalls.push({ file, path, value })
    // Naive in-memory model: only handle single-key top-level object updates.
    const current = this.files.get(file) ?? ''
    let obj: Record<string, unknown> = {}
    if (current.trim() !== '') {
      try {
        obj = JSON.parse(current.replace(/^\/\/[^\n]*\n/gm, ''))
      } catch {
        obj = {}
      }
    }
    if (path.length === 1 && typeof path[0] === 'string') {
      if (value === undefined) {
        delete obj[path[0]]
      } else {
        obj[path[0]] = value
      }
    }
    this.files.set(file, JSON.stringify(obj, null, 2))
    return true
  }
  async getFileUri(_file: UserDataFile): Promise<UriComponents | null> {
    return URI.file('/fake/path').toJSON()
  }
  fire(file: UserDataFile): void {
    this._emitter.fire(file)
  }
}

function makeInstance(
  storage: FakeStorage,
  files: FakeUserData,
): {
  sync: UserSettingsSync
  config: ConfigurationService
} {
  const config = new ConfigurationService()
  const services = new ServiceCollection()
  services.set(IConfigurationService, config)
  services.set(IStorageService, storage)
  services.set(IUserDataFilesService, files)
  const inst = new InstantiationService(services)
  const sync = inst.createInstance(UserSettingsSync)
  return { sync, config }
}

describe('UserSettingsSync', () => {
  it('initialize() loads settings.json into the User layer', async () => {
    const storage = new FakeStorage()
    const files = new FakeUserData()
    files.files.set(
      UserDataFile.Settings,
      '// hello\n{ "editor.fontSize": 16, "workbench.colorTheme": "light" }',
    )
    const { sync, config } = makeInstance(storage, files)

    await sync.initialize()
    expect(config.get('editor.fontSize')).toBe(16)
    expect(config.get('workbench.colorTheme')).toBe('light')
    sync.dispose()
    config.dispose()
  })

  it('initialize() falls back to {} when settings.json is empty', async () => {
    const storage = new FakeStorage()
    const files = new FakeUserData()
    const { sync, config } = makeInstance(storage, files)
    await sync.initialize()
    expect(config.get('anything')).toBeUndefined()
    sync.dispose()
    config.dispose()
  })

  it('migrates legacy storage entry into settings.json on first launch', async () => {
    const storage = new FakeStorage()
    storage.preset(USER_SETTINGS_KEY, { 'editor.fontSize': 16 })
    const files = new FakeUserData()
    const { sync, config } = makeInstance(storage, files)

    await sync.initialize()
    expect(config.get('editor.fontSize')).toBe(16)
    expect(files.files.get(UserDataFile.Settings)).toContain('"editor.fontSize": 16')
    expect(await storage.get(USER_SETTINGS_KEY)).toEqual({})
    sync.dispose()
    config.dispose()
  })

  it('User-layer update is persisted to settings.json via setValue', async () => {
    const storage = new FakeStorage()
    const files = new FakeUserData()
    const { sync, config } = makeInstance(storage, files)
    await sync.initialize()

    config.update('editor.fontSize', 18, ConfigurationTarget.User)
    // Allow async writeback to fire.
    await Promise.resolve()
    await Promise.resolve()
    expect(files.setValueCalls).toHaveLength(1)
    expect(files.setValueCalls[0]?.path).toEqual(['editor.fontSize'])
    expect(files.setValueCalls[0]?.value).toBe(18)
    sync.dispose()
    config.dispose()
  })

  it('external file change reloads the User layer', async () => {
    const storage = new FakeStorage()
    const files = new FakeUserData()
    const { sync, config } = makeInstance(storage, files)
    await sync.initialize()
    expect(config.get('editor.fontSize')).toBeUndefined()

    files.files.set(UserDataFile.Settings, '{ "editor.fontSize": 22 }')
    files.fire(UserDataFile.Settings)
    // onDidChangeFile -> async reload; flush microtasks.
    await Promise.resolve()
    await Promise.resolve()
    expect(config.get('editor.fontSize')).toBe(22)
    sync.dispose()
    config.dispose()
  })

  it('after dispose, no further setValue writes happen', async () => {
    const storage = new FakeStorage()
    const files = new FakeUserData()
    const { sync, config } = makeInstance(storage, files)
    await sync.initialize()
    sync.dispose()

    files.setValueCalls.length = 0
    config.update('x', 1, ConfigurationTarget.User)
    await Promise.resolve()
    expect(files.setValueCalls).toHaveLength(0)
    config.dispose()
  })
})
