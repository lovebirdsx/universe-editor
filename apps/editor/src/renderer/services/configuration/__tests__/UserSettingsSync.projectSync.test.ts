import { describe, expect, it } from 'vitest'
import {
  ConfigurationService,
  ConfigurationTarget,
  Emitter,
  Event,
  IConfigurationService,
  IStorageService,
  type IUserDataFileChange,
  IUserDataFilesService,
  IUriIdentityService,
  InstantiationService,
  ServiceCollection,
  URI,
  UriIdentityService,
  UserDataFile,
} from '@universe-editor/platform'
import { UserSettingsSync } from '../UserSettingsSync.js'
import { DidSaveNotification } from '../../extensions/DidSaveNotification.js'

class FakeStorage implements IStorageService {
  declare readonly _serviceBrand: undefined
  store = new Map<string, unknown>()
  readonly onDidChangeWorkspaceScope = Event.None
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

class FakeUserData implements IUserDataFilesService {
  declare readonly _serviceBrand: undefined
  files = new Map<UserDataFile, string>()
  setValueCalls: Array<{ file: UserDataFile; path: readonly (string | number)[]; value: unknown }> =
    []
  private readonly _emitter = new Emitter<IUserDataFileChange>()
  readonly onDidChangeFile = this._emitter.event

  async read(file: UserDataFile): Promise<string> {
    return this.files.get(file) ?? ''
  }
  async write(file: UserDataFile, content: string): Promise<void> {
    this.files.set(file, content)
  }
  async setValue(
    file: UserDataFile,
    path: readonly (string | number)[],
    value: unknown,
  ): Promise<boolean> {
    this.setValueCalls.push({ file, path, value })
    const current = this.files.get(file) ?? ''
    let obj: Record<string, unknown> = {}
    if (current.trim() !== '') {
      try {
        obj = JSON.parse(current)
      } catch {
        obj = {}
      }
    }
    if (path.length === 1 && typeof path[0] === 'string') {
      if (value === undefined) delete obj[path[0]]
      else obj[path[0]] = value
    }
    this.files.set(file, JSON.stringify(obj, null, 2))
    return true
  }
  async getFileUri(file: UserDataFile): Promise<URI | null> {
    return URI.file(`/fake/${file}`)
  }
  fire(file: UserDataFile, source: 'self' | 'external' = 'external'): void {
    this._emitter.fire({ file, source })
  }
}

function makeInstance(files: FakeUserData): {
  sync: UserSettingsSync
  config: ConfigurationService
} {
  const config = new ConfigurationService()
  const storage = new FakeStorage()
  const services = new ServiceCollection()
  services.set(IConfigurationService, config)
  services.set(IStorageService, storage)
  services.set(IUserDataFilesService, files)
  services.set(IUriIdentityService, new UriIdentityService('linux'))
  const inst = new InstantiationService(services)
  const sync = inst.createInstance(UserSettingsSync)
  return { sync, config }
}

describe('UserSettingsSync — Project layer', () => {
  it('initialize() loads ProjectSettings into the Project layer', async () => {
    const files = new FakeUserData()
    files.files.set(UserDataFile.ProjectSettings, '{ "editor.tabSize": 2 }')
    const { sync, config } = makeInstance(files)

    await sync.initialize()
    expect(config.get('editor.tabSize')).toBe(2)
    expect(
      (config.getLayerSnapshot(ConfigurationTarget.Project) as Record<string, unknown>)[
        'editor.tabSize'
      ],
    ).toBe(2)
    sync.dispose()
    config.dispose()
  })

  it('Project-layer update is persisted to ProjectSettings file via setValue', async () => {
    const files = new FakeUserData()
    const { sync, config } = makeInstance(files)
    await sync.initialize()

    config.update('editor.tabSize', 4, ConfigurationTarget.Project)
    // flush async writeback
    await Promise.resolve()
    await Promise.resolve()

    const projectCalls = files.setValueCalls.filter((c) => c.file === UserDataFile.ProjectSettings)
    expect(projectCalls).toHaveLength(1)
    expect(projectCalls[0]?.path).toEqual(['editor.tabSize'])
    expect(projectCalls[0]?.value).toBe(4)
    sync.dispose()
    config.dispose()
  })

  it('User-layer update does NOT write to ProjectSettings', async () => {
    const files = new FakeUserData()
    const { sync, config } = makeInstance(files)
    await sync.initialize()

    config.update('editor.fontSize', 16, ConfigurationTarget.User)
    await Promise.resolve()
    await Promise.resolve()

    const projectCalls = files.setValueCalls.filter((c) => c.file === UserDataFile.ProjectSettings)
    expect(projectCalls).toHaveLength(0)
    sync.dispose()
    config.dispose()
  })

  it('external ProjectSettings file change reloads Project layer', async () => {
    const files = new FakeUserData()
    const { sync, config } = makeInstance(files)
    await sync.initialize()
    expect(config.get('editor.tabSize')).toBeUndefined()

    files.files.set(UserDataFile.ProjectSettings, '{ "editor.tabSize": 8 }')
    files.fire(UserDataFile.ProjectSettings)
    await Promise.resolve()
    await Promise.resolve()

    expect(
      (config.getLayerSnapshot(ConfigurationTarget.Project) as Record<string, unknown>)[
        'editor.tabSize'
      ],
    ).toBe(8)
    sync.dispose()
    config.dispose()
  })

  it('in-workbench save of project settings.json reloads the Project layer', async () => {
    const files = new FakeUserData()
    const { sync, config } = makeInstance(files)
    await sync.initialize()
    expect(config.get('terminal.integrated.cwd')).toBeUndefined()

    // Simulate FileEditorInput.save(): the file is written through IFileService
    // (bypassing UserDataMainService's atomic-write self-notification), then
    // DidSaveNotification fires with the saved URI.
    files.files.set(
      UserDataFile.ProjectSettings,
      '{ "terminal.integrated.cwd": "${workspaceFolder}/src" }',
    )
    DidSaveNotification.notify(URI.file(`/fake/${UserDataFile.ProjectSettings}`))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(
      (config.getLayerSnapshot(ConfigurationTarget.Project) as Record<string, unknown>)[
        'terminal.integrated.cwd'
      ],
    ).toBe('${workspaceFolder}/src')
    sync.dispose()
    config.dispose()
  })

  it('in-workbench save of an unrelated file does not reload any layer', async () => {
    const files = new FakeUserData()
    const { sync, config } = makeInstance(files)
    await sync.initialize()

    files.files.set(UserDataFile.ProjectSettings, '{ "editor.tabSize": 8 }')
    DidSaveNotification.notify(URI.file('/some/other/file.ts'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(
      (config.getLayerSnapshot(ConfigurationTarget.Project) as Record<string, unknown>)[
        'editor.tabSize'
      ],
    ).toBeUndefined()
    sync.dispose()
    config.dispose()
  })
})
