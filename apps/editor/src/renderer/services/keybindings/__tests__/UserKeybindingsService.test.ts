import { afterEach, describe, expect, it } from 'vitest'
import {
  CommandsRegistry,
  Emitter,
  Event,
  KeybindingsRegistry,
  KeybindingWeight,
  URI,
  UserDataFile,
  type IDisposable,
  type IUserDataFileChange,
  type IStorageService,
  type IUserDataFilesService,
  type StorageScope,
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
  private readonly _emitter = new Emitter<IUserDataFileChange>()
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

  async getFileUri(_file: UserDataFile): Promise<URI | null> {
    return URI.file('/fake/keybindings.json')
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
    expect(KeybindingsRegistry.resolveKeystroke('ctrl+u', undefined, ['ctrl+k'])).toMatchObject({
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

    expect(KeybindingsRegistry.resolveKeystroke('ctrl+shift+d')).toMatchObject({
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

    expect(KeybindingsRegistry.resolveKeystroke('ctrl+shift+d')).toMatchObject({
      kind: 'execute',
      command: cmd,
    })
    expect(KeybindingsRegistry.resolveKeystroke('shift+alt+down')).toMatchObject({
      kind: 'execute',
      command: cmd,
    })
  })

  it('collects disabled commands from both layers, deduped', async () => {
    const cmd = 'editor.action.insertCursorAbove'
    disposables.push(CommandsRegistry.registerCommand({ id: cmd, handler: () => {} }))

    const files = new FakeUserData()
    files.files.set(
      UserDataFile.VSCodeKeybindings,
      JSON.stringify([{ command: `-${cmd}`, when: 'editorTextFocus' }, { command: '-foo.bar' }]),
    )
    files.files.set(UserDataFile.Keybindings, JSON.stringify([{ command: '-foo.bar' }]))
    const service = new UserKeybindingsService(new FakeStorage(), files)
    disposables.push(service)

    await service.initialize()

    expect([...service.disabledCommands].sort()).toEqual([cmd, 'foo.bar'])
  })

  it('clears disabled commands when the disable entry is removed', async () => {
    const files = new FakeUserData()
    files.files.set(UserDataFile.VSCodeKeybindings, JSON.stringify([{ command: '-foo.bar' }]))
    const service = new UserKeybindingsService(new FakeStorage(), files)
    disposables.push(service)

    await service.initialize()
    expect(service.disabledCommands).toContain('foo.bar')

    files.files.set(UserDataFile.VSCodeKeybindings, '[]')
    await service.reload()
    expect(service.disabledCommands).not.toContain('foo.bar')
  })

  it('carries `args` from the keybindings file through to keystroke resolution', async () => {
    disposables.push(
      CommandsRegistry.registerCommand({ id: 'workbench.action.quickOpen', handler: () => {} }),
    )

    const files = new FakeUserData()
    files.files.set(
      UserDataFile.Keybindings,
      JSON.stringify([{ key: 'ctrl+r', command: 'workbench.action.quickOpen', args: '@:' }]),
    )
    const service = new UserKeybindingsService(new FakeStorage(), files)
    disposables.push(service)

    await service.initialize()

    const resolution = KeybindingsRegistry.resolveKeystroke('ctrl+r')
    expect(resolution).toMatchObject({
      kind: 'execute',
      command: 'workbench.action.quickOpen',
      args: '@:',
    })
    // The parsed user entry retains args so the Keyboard Shortcuts editor can round-trip it.
    expect(service.getUserEntry('workbench.action.quickOpen')?.args).toBe('@:')
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

  it('preserves the key on a `-command` removal so only that key is freed', async () => {
    const cmd = 'editor.action.nextMatchFindAction'
    disposables.push(CommandsRegistry.registerCommand({ id: cmd, handler: () => {} }))
    // A live default binding plus a sibling on a different key.
    disposables.push(
      KeybindingsRegistry.registerKeybinding({ key: 'f3', command: cmd, weight: 50 }),
    )
    disposables.push(
      KeybindingsRegistry.registerKeybinding({ key: 'enter', command: cmd, weight: 50 }),
    )

    const files = new FakeUserData()
    files.files.set(
      UserDataFile.VSCodeKeybindings,
      JSON.stringify([{ key: 'f3', command: `-${cmd}` }]),
    )
    const service = new UserKeybindingsService(new FakeStorage(), files)
    disposables.push(service)
    await service.initialize()

    // F3 is freed (no positive binding wins it)...
    expect(KeybindingsRegistry.resolveKeystroke('f3').kind).toBe('no-match')
    // ...but the sibling Enter binding survives.
    expect(KeybindingsRegistry.resolveKeystroke('enter')).toMatchObject({
      kind: 'execute',
      command: cmd,
    })
    // A keyed removal does NOT mark the whole command disabled.
    expect(service.disabledCommands).not.toContain(cmd)
    expect(service.disabledBindings).toContainEqual({ command: cmd, key: 'f3' })
  })

  it('setKeybinding auto-negates the original default key on rebind', async () => {
    const cmd = 'workbench.action.foo'
    disposables.push(CommandsRegistry.registerCommand({ id: cmd, handler: () => {} }))
    // Project default binding (below User weight) on ctrl+alt+p.
    disposables.push(
      KeybindingsRegistry.registerKeybinding({
        key: 'ctrl+alt+p',
        command: cmd,
        weight: KeybindingWeight.WorkbenchContrib,
      }),
    )

    const files = new FakeUserData()
    const service = new UserKeybindingsService(new FakeStorage(), files)
    disposables.push(service)
    await service.initialize()

    service.setKeybinding(cmd, 'ctrl+alt+n')

    // New key fires the command.
    expect(KeybindingsRegistry.resolveKeystroke('ctrl+alt+n')).toMatchObject({
      kind: 'execute',
      command: cmd,
    })
    // Original key no longer fires it (auto-negated).
    expect(KeybindingsRegistry.resolveKeystroke('ctrl+alt+p').kind).toBe('no-match')
  })
})
