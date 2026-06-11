import { afterEach, describe, expect, it } from 'vitest'
import {
  CommandsRegistry,
  Emitter,
  Event,
  KeybindingsRegistry,
  URI,
  UserDataFile,
  type IDisposable,
  type IStorageService,
  type IUserDataFilesService,
  type StorageScope,
  type UriComponents,
} from '@universe-editor/platform'
import { UserKeybindingsService } from '../UserKeybindingsService.js'

class FakeStorage implements IStorageService {
  declare readonly _serviceBrand: undefined
  readonly onDidChangeWorkspaceScope = Event.None
  private readonly _values = new Map<string, unknown>()

  async get<T = unknown>(key: string, _scope?: StorageScope): Promise<T | undefined> {
    return this._values.get(key) as T | undefined
  }

  async set(key: string, value: unknown, _scope?: StorageScope): Promise<void> {
    this._values.set(key, value)
  }

  async remove(key: string, _scope?: StorageScope): Promise<void> {
    this._values.delete(key)
  }
}

class FakeUserData implements IUserDataFilesService {
  declare readonly _serviceBrand: undefined
  readonly files = new Map<UserDataFile, string>()
  private readonly _emitter = new Emitter<UserDataFile>()
  readonly onDidChangeFile = this._emitter.event

  async read(file: UserDataFile): Promise<string> {
    return this.files.get(file) ?? ''
  }

  async write(file: UserDataFile, content: string): Promise<void> {
    this.files.set(file, content)
  }

  async setValue(
    _file: UserDataFile,
    _jsonPath: readonly (string | number)[],
    _value: unknown,
  ): Promise<boolean> {
    return true
  }

  async getFileUri(_file: UserDataFile): Promise<UriComponents | null> {
    return URI.file('/fake/keybindings.json').toJSON()
  }
}

describe('UserKeybindingsService', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('registers VSCode keybindings with space-separated chords as two-stroke bindings', async () => {
    disposables.push(
      CommandsRegistry.registerCommand({
        id: 'git.sync',
        handler: () => {},
      }),
    )

    const files = new FakeUserData()
    files.files.set(
      UserDataFile.VSCodeKeybindings,
      '[{ "key": "ctrl+k ctrl+u", "command": "git.sync" }]',
    )
    const service = new UserKeybindingsService(new FakeStorage(), files)
    disposables.push(service)

    await service.initialize()

    expect(KeybindingsRegistry.resolveKeystroke('ctrl+k').kind).toBe('enter-chord')
    expect(KeybindingsRegistry.resolveKeystroke('ctrl+u', undefined, ['ctrl+k'])).toEqual({
      kind: 'execute',
      command: 'git.sync',
    })
  })

  it('re-applies VSCode bindings to commands registered after initialize() once reload() runs', async () => {
    const lazyCommand = 'test.lazy.copyLinesDown'
    const files = new FakeUserData()
    files.files.set(
      UserDataFile.VSCodeKeybindings,
      `[{ "key": "ctrl+shift+d", "command": "${lazyCommand}" }]`,
    )
    const service = new UserKeybindingsService(new FakeStorage(), files)
    disposables.push(service)

    await service.initialize()

    // Command not registered yet → binding skipped by the command-existence filter.
    expect(KeybindingsRegistry.resolveKeystroke('ctrl+shift+d').kind).toBe('no-match')

    // Command registers lazily (mirrors the monaco action bridge), then reload picks it up.
    disposables.push(CommandsRegistry.registerCommand({ id: lazyCommand, handler: () => {} }))
    await service.reload()

    expect(KeybindingsRegistry.resolveKeystroke('ctrl+shift+d')).toEqual({
      kind: 'execute',
      command: lazyCommand,
    })
  })

  it('keeps every VSCode binding when one command has multiple entries', async () => {
    const cmd = 'editor.action.copyLinesDownAction'
    disposables.push(CommandsRegistry.registerCommand({ id: cmd, handler: () => {} }))

    const files = new FakeUserData()
    files.files.set(
      UserDataFile.VSCodeKeybindings,
      JSON.stringify([
        { key: 'ctrl+shift+d', command: cmd, when: 'editorTextFocus && !editorReadonly' },
        { key: 'shift+alt+down', command: cmd, when: 'editorTextFocus && !editorReadonly' },
      ]),
    )
    const service = new UserKeybindingsService(new FakeStorage(), files)
    disposables.push(service)

    await service.initialize()

    expect(KeybindingsRegistry.resolveKeystroke('ctrl+shift+d')).toEqual({
      kind: 'execute',
      command: cmd,
    })
    expect(KeybindingsRegistry.resolveKeystroke('shift+alt+down')).toEqual({
      kind: 'execute',
      command: cmd,
    })
  })

  it('serializes concurrent reload() calls without duplicating registrations', async () => {
    const lazyCommand = 'test.lazy.serialized'
    disposables.push(CommandsRegistry.registerCommand({ id: lazyCommand, handler: () => {} }))

    const files = new FakeUserData()
    files.files.set(
      UserDataFile.VSCodeKeybindings,
      `[{ "key": "ctrl+alt+j", "command": "${lazyCommand}" }]`,
    )
    const service = new UserKeybindingsService(new FakeStorage(), files)
    disposables.push(service)

    await service.initialize()
    await Promise.all([service.reload(), service.reload()])

    const bound = KeybindingsRegistry.getAllKeybindings().filter(
      (kb) => kb.command === lazyCommand && !kb.isNegated,
    )
    expect(bound).toHaveLength(1)
  })
})
