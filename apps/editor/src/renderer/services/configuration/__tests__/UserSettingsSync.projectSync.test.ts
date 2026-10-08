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
  /** While held, reads of the file stay pending in ISSUE order — the channel's
   *  own ordering, which the layer loads rely on: the request issued first is
   *  answered first. */
  private readonly _heldFiles = new Set<UserDataFile>()
  private readonly _held: Array<{ file: UserDataFile; release: () => void }> = []

  holdReads(file: UserDataFile, hold: boolean): void {
    if (hold) {
      this._heldFiles.add(file)
      return
    }
    this._heldFiles.delete(file)
    const keep: Array<{ file: UserDataFile; release: () => void }> = []
    for (const entry of this._held) {
      if (entry.file === file) entry.release()
      else keep.push(entry)
    }
    this._held.length = 0
    this._held.push(...keep)
  }

  heldReads(file: UserDataFile): number {
    return this._held.filter((entry) => entry.file === file).length
  }

  async read(file: UserDataFile): Promise<string> {
    // Content is captured when the request is MADE, like main's own read.
    const text = this.files.get(file) ?? ''
    if (this._heldFiles.has(file)) {
      await new Promise<void>((release) => this._held.push({ file, release }))
    }
    return text
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

  it('a change announced while initialize() is still loading is not dropped', async () => {
    const files = new FakeUserData()
    const { sync, config } = makeInstance(files)

    // Startup reads the Project file before any workspace exists, so that read
    // is answered with nothing. Opening a workspace makes main install that
    // workspace's settings slot and announce the file — possibly while that
    // read is still in flight. The announcement must not be lost: nothing
    // re-reads the file afterwards, so the session would run on the empty
    // pre-workspace layer with the workspace's values never unpacked.
    files.holdReads(UserDataFile.ProjectSettings, true)
    const initializing = sync.initialize()
    for (let i = 0; i < 50 && files.heldReads(UserDataFile.ProjectSettings) === 0; i++) {
      await Promise.resolve()
    }
    expect(files.heldReads(UserDataFile.ProjectSettings)).toBe(1)

    files.files.set(UserDataFile.ProjectSettings, '{ "editor.tabSize": 8 }')
    files.fire(UserDataFile.ProjectSettings)
    files.holdReads(UserDataFile.ProjectSettings, false)
    await initializing
    await Promise.resolve()
    await Promise.resolve()

    expect(config.getLayerSnapshot(ConfigurationTarget.Project) as Record<string, unknown>).toEqual(
      { 'editor.tabSize': 8 },
    )
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
