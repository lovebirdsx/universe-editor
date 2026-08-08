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
  /** When set, each read() awaits this gate — lets a test hold the reload mid-flight. */
  readGate: (() => Promise<void>) | undefined

  async read(file: UserDataFile): Promise<string> {
    await this.readGate?.()
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

  it('keeps the user binding resolvable throughout a reload (no transient gap)', async () => {
    // Regression for the Ctrl+R race: _reloadVSCodeAndUser() used to clear the
    // user store, THEN await both file reads, THEN re-register — leaving a
    // window where the user entry was absent and a lower-weight binding
    // (openRecent) or a when-gated VSCode shadow won instead.
    const cmd = 'workbench.action.quickOpen'
    disposables.push(CommandsRegistry.registerCommand({ id: cmd, handler: () => {} }))

    const files = new FakeUserData()
    files.files.set(UserDataFile.Keybindings, JSON.stringify([{ key: 'ctrl+r', command: cmd }]))
    const service = new UserKeybindingsService(new FakeStorage(), files)
    disposables.push(service)
    await service.initialize()
    expect(KeybindingsRegistry.resolveKeystroke('ctrl+r')).toMatchObject({
      kind: 'execute',
      command: cmd,
    })

    // Hold the reload mid-flight: every file read parks until we release them all.
    // Both layers read CONCURRENTLY (Promise.all) before any store is cleared, so
    // a single-shot gate would only free one read and hang the other — collect
    // the pending resolvers and flush them together.
    const pendingReads: Array<() => void> = []
    files.readGate = () =>
      new Promise<void>((resolve) => {
        pendingReads.push(resolve)
      })
    const reloading = service.reload()
    // Spin until at least one read has parked — don't count microtasks.
    for (let i = 0; i < 50 && pendingReads.length === 0; i++) await Promise.resolve()
    expect(pendingReads.length).toBeGreaterThan(0)

    // The reload is now parked inside its awaited file read(s). A key event arriving
    // here must STILL resolve to the user's binding — the registry must not have
    // been torn down yet. (With the old clear-then-await order this was openRecent.)
    expect(KeybindingsRegistry.resolveKeystroke('ctrl+r')).toMatchObject({
      kind: 'execute',
      command: cmd,
    })

    for (const release of pendingReads.splice(0)) release()
    await reloading
    // After the reload completes the binding is still intact, exactly once.
    expect(KeybindingsRegistry.resolveKeystroke('ctrl+r')).toMatchObject({
      kind: 'execute',
      command: cmd,
    })
    expect(
      KeybindingsRegistry.getAllKeybindings().filter((kb) => kb.command === cmd && !kb.isNegated),
    ).toHaveLength(1)
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

  describe('row-level API (multi-key per command)', () => {
    const flushWrites = () => new Promise((r) => setTimeout(r, 0))

    const writtenFileEntries = (files: FakeUserData) => {
      const text = files.files.get(UserDataFile.Keybindings) ?? ''
      return JSON.parse(text.slice(text.indexOf('['))) as Array<Record<string, unknown>>
    }

    const setup = async (cmd: string, defaultKeys: string[] = []) => {
      disposables.push(CommandsRegistry.registerCommand({ id: cmd, handler: () => {} }))
      for (const key of defaultKeys) {
        disposables.push(
          KeybindingsRegistry.registerKeybinding({
            key,
            command: cmd,
            weight: KeybindingWeight.WorkbenchContrib,
          }),
        )
      }
      const files = new FakeUserData()
      const service = new UserKeybindingsService(new FakeStorage(), files)
      disposables.push(service)
      await service.initialize()
      return { files, service }
    }

    it('addKeybinding lets multiple keys coexist for one command without removals', async () => {
      const cmd = 'test.rows.add'
      const { files, service } = await setup(cmd, ['alt+ctrl+p'])

      service.addKeybinding(cmd, 'Alt+Ctrl+N')
      service.addKeybinding(cmd, 'alt+ctrl+m', 'editorTextFocus')

      const entries = service.getUserEntries(cmd)
      expect(entries).toHaveLength(2)
      expect(entries.map((e) => e.key)).toEqual(['alt+ctrl+n', 'alt+ctrl+m'])
      expect(entries[1]!.when).toBe('editorTextFocus')
      expect(service.userEntries.some((e) => e.isRemoval)).toBe(false)

      expect(KeybindingsRegistry.resolveKeystroke('alt+ctrl+n')).toMatchObject({
        kind: 'execute',
        command: cmd,
      })
      expect(KeybindingsRegistry.resolveKeystroke('alt+ctrl+m')).toMatchObject({
        kind: 'execute',
        command: cmd,
      })
      // The default key stays live — addKeybinding never negates.
      expect(KeybindingsRegistry.resolveKeystroke('alt+ctrl+p')).toMatchObject({
        kind: 'execute',
        command: cmd,
      })

      await flushWrites()
      expect(writtenFileEntries(files)).toEqual([
        { key: 'alt+ctrl+n', command: cmd },
        { key: 'alt+ctrl+m', command: cmd, when: 'editorTextFocus' },
      ])
    })

    it('editKeybinding on a user entry re-keys only that entry', async () => {
      const cmd = 'test.rows.editUser'
      const { files, service } = await setup(cmd)

      service.addKeybinding(cmd, 'alt+ctrl+n')
      service.addKeybinding(cmd, 'alt+ctrl+m')

      service.editKeybinding(
        { command: cmd, key: 'alt+ctrl+n', when: undefined, isDefault: false },
        'alt+ctrl+x',
        'editorTextFocus',
      )

      const entries = service.getUserEntries(cmd)
      expect(entries).toHaveLength(2)
      expect(entries[0]).toMatchObject({ key: 'alt+ctrl+x', when: 'editorTextFocus' })
      expect(entries[1]).toEqual({ command: cmd, key: 'alt+ctrl+m' })

      expect(KeybindingsRegistry.resolveKeystroke('alt+ctrl+n').kind).toBe('no-match')
      expect(KeybindingsRegistry.resolveKeystroke('alt+ctrl+x')).toMatchObject({
        kind: 'execute',
        command: cmd,
      })
      expect(KeybindingsRegistry.resolveKeystroke('alt+ctrl+m')).toMatchObject({
        kind: 'execute',
        command: cmd,
      })

      await flushWrites()
      expect(writtenFileEntries(files)).toEqual([
        { key: 'alt+ctrl+x', command: cmd, when: 'editorTextFocus' },
        { key: 'alt+ctrl+m', command: cmd },
      ])
    })

    it('editKeybinding on a user entry clears when when the new value is undefined', async () => {
      const cmd = 'test.rows.editUserClearWhen'
      const { service } = await setup(cmd)

      service.addKeybinding(cmd, 'alt+ctrl+n', 'editorTextFocus')
      service.editKeybinding(
        { command: cmd, key: 'alt+ctrl+n', when: 'editorTextFocus', isDefault: false },
        'alt+ctrl+x',
      )

      expect(service.getUserEntries(cmd)).toEqual([{ command: cmd, key: 'alt+ctrl+x' }])
    })

    it('editKeybinding on an unmatched user row falls back to appending', async () => {
      const cmd = 'test.rows.editUserMiss'
      const { service } = await setup(cmd)

      service.editKeybinding(
        { command: cmd, key: 'alt+ctrl+q', when: undefined, isDefault: false },
        'alt+ctrl+x',
      )

      expect(service.getUserEntries(cmd)).toEqual([{ command: cmd, key: 'alt+ctrl+x' }])
    })

    it('editKeybinding on a default entry appends a positive plus a removal of only that key', async () => {
      const cmd = 'test.rows.editDefault'
      const { files, service } = await setup(cmd, ['alt+ctrl+p', 'alt+ctrl+o'])

      service.editKeybinding(
        { command: cmd, key: 'alt+ctrl+p', when: undefined, isDefault: true },
        'alt+ctrl+n',
        'editorTextFocus',
      )

      expect(service.getUserEntries(cmd)).toEqual([
        { command: cmd, key: 'alt+ctrl+n', when: 'editorTextFocus' },
      ])
      const removals = service.userEntries.filter((e) => e.isRemoval)
      expect(removals).toEqual([{ command: cmd, key: 'alt+ctrl+p', isRemoval: true }])

      // Old key freed, sibling default key untouched.
      expect(KeybindingsRegistry.resolveKeystroke('alt+ctrl+p').kind).toBe('no-match')
      expect(KeybindingsRegistry.resolveKeystroke('alt+ctrl+o')).toMatchObject({
        kind: 'execute',
        command: cmd,
      })
      expect(KeybindingsRegistry.resolveKeystroke('alt+ctrl+n')).toMatchObject({
        kind: 'execute',
        command: cmd,
      })

      await flushWrites()
      expect(writtenFileEntries(files)).toEqual([
        { key: 'alt+ctrl+n', command: cmd, when: 'editorTextFocus' },
        { command: `-${cmd}`, key: 'alt+ctrl+p' },
      ])

      // Editing the same default row again must not duplicate the removal.
      service.editKeybinding(
        { command: cmd, key: 'alt+ctrl+p', when: undefined, isDefault: true },
        'alt+ctrl+y',
      )
      expect(service.userEntries.filter((e) => e.isRemoval)).toHaveLength(1)
    })

    it('editKeybinding on a default entry skips the removal when re-assigning the same key', async () => {
      const cmd = 'test.rows.editDefaultSameKey'
      const { service } = await setup(cmd, ['alt+ctrl+p'])

      service.editKeybinding(
        { command: cmd, key: 'Alt+Ctrl+P', when: undefined, isDefault: true },
        'alt+ctrl+p',
      )

      expect(service.getUserEntries(cmd)).toEqual([{ command: cmd, key: 'alt+ctrl+p' }])
      expect(service.userEntries.some((e) => e.isRemoval)).toBe(false)
    })

    it('removeKeybinding on a user entry deletes exactly that row', async () => {
      const cmd = 'test.rows.removeUser'
      const { files, service } = await setup(cmd)

      service.addKeybinding(cmd, 'alt+ctrl+n')
      service.addKeybinding(cmd, 'alt+ctrl+m')

      service.removeKeybinding({
        command: cmd,
        key: 'alt+ctrl+n',
        when: undefined,
        isDefault: false,
      })

      expect(service.getUserEntries(cmd)).toEqual([{ command: cmd, key: 'alt+ctrl+m' }])
      expect(KeybindingsRegistry.resolveKeystroke('alt+ctrl+n').kind).toBe('no-match')
      expect(KeybindingsRegistry.resolveKeystroke('alt+ctrl+m')).toMatchObject({
        kind: 'execute',
        command: cmd,
      })

      await flushWrites()
      expect(writtenFileEntries(files)).toEqual([{ key: 'alt+ctrl+m', command: cmd }])
    })

    it('removeKeybinding on a default entry writes a `-command` removal for that key', async () => {
      const cmd = 'test.rows.removeDefault'
      const { files, service } = await setup(cmd, ['alt+ctrl+p', 'alt+ctrl+o'])

      service.removeKeybinding({
        command: cmd,
        key: 'alt+ctrl+p',
        when: undefined,
        isDefault: true,
      })

      expect(service.getUserEntries(cmd)).toEqual([])
      expect(service.userEntries).toEqual([{ command: cmd, key: 'alt+ctrl+p', isRemoval: true }])
      expect(KeybindingsRegistry.resolveKeystroke('alt+ctrl+p').kind).toBe('no-match')
      expect(KeybindingsRegistry.resolveKeystroke('alt+ctrl+o')).toMatchObject({
        kind: 'execute',
        command: cmd,
      })

      await flushWrites()
      expect(writtenFileEntries(files)).toEqual([{ command: `-${cmd}`, key: 'alt+ctrl+p' }])
    })

    it('removeKeybinding on an unbound row is a no-op', async () => {
      const cmd = 'test.rows.removeUnbound'
      const { service } = await setup(cmd)

      service.removeKeybinding({ command: cmd, key: undefined, when: undefined, isDefault: true })
      service.removeKeybinding({ command: cmd, key: undefined, when: undefined, isDefault: false })

      expect(service.userEntries).toEqual([])
    })

    it('resetKeybinding clears every user entry of the command, restoring defaults', async () => {
      const cmd = 'test.rows.reset'
      const { files, service } = await setup(cmd, ['alt+ctrl+p'])

      service.editKeybinding(
        { command: cmd, key: 'alt+ctrl+p', when: undefined, isDefault: true },
        'alt+ctrl+n',
      )
      service.addKeybinding(cmd, 'alt+ctrl+m')
      expect(service.userEntries).toHaveLength(3)

      service.resetKeybinding(cmd)

      expect(service.userEntries).toEqual([])
      expect(KeybindingsRegistry.resolveKeystroke('alt+ctrl+p')).toMatchObject({
        kind: 'execute',
        command: cmd,
      })
      expect(KeybindingsRegistry.resolveKeystroke('alt+ctrl+n').kind).toBe('no-match')
      expect(KeybindingsRegistry.resolveKeystroke('alt+ctrl+m').kind).toBe('no-match')

      await flushWrites()
      expect(writtenFileEntries(files)).toEqual([])
    })
  })
})
