import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Emitter,
  type Event,
  type IUserDataFileChange,
  URI,
  UserDataFile,
  type IWorkspace,
} from '@universe-editor/platform'

let currentUserData = ''

vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => {
      if (key === 'userData') return currentUserData
      throw new Error(`unexpected key: ${key}`)
    },
  },
}))

// Imported after vi.mock so the mock is in place.
const { UserDataMainService } = await import('../userDataMainService.js')

class FakeWorkspace {
  private _current: IWorkspace | null = null
  private readonly _emitter = new Emitter<IWorkspace | null>()
  readonly onDidChangeWorkspace: Event<IWorkspace | null> = this._emitter.event
  async getCurrent(): Promise<IWorkspace | null> {
    return this._current
  }
  fire(ws: IWorkspace | null): void {
    this._current = ws
    this._emitter.fire(ws)
  }
}

describe('UserDataMainService', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), 'ued-userdata-'))
    currentUserData = join(tmp, 'userData')
    await fs.mkdir(currentUserData, { recursive: true })
  })

  afterEach(async () => {
    try {
      await fs.rm(tmp, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('read() returns empty string when settings.json does not exist', async () => {
    const ws = new FakeWorkspace()
    const svc = new UserDataMainService(ws as never)
    expect(await svc.read(UserDataFile.Settings)).toBe('')
    svc.dispose()
  })

  it('write() round-trips through read()', async () => {
    const ws = new FakeWorkspace()
    const svc = new UserDataMainService(ws as never)
    await svc.write(UserDataFile.Settings, '{"editor.fontSize": 14}\n')
    expect(await svc.read(UserDataFile.Settings)).toBe('{"editor.fontSize": 14}\n')
    svc.dispose()
  })

  it('loads settings/keybindings from an explicit configDir, not userData', async () => {
    const ws = new FakeWorkspace()
    const configDir = join(tmp, 'config')
    await fs.mkdir(configDir, { recursive: true })
    const svc = new UserDataMainService(ws as never, configDir)
    await svc.write(UserDataFile.Settings, '{"a":1}\n')
    expect(await fs.readFile(join(configDir, 'settings.json'), 'utf8')).toBe('{"a":1}\n')
    await expect(fs.stat(join(currentUserData, 'settings.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    svc.dispose()
  })

  it('setValue() preserves // line comments in settings.json', async () => {
    const ws = new FakeWorkspace()
    const svc = new UserDataMainService(ws as never)
    await svc.write(UserDataFile.Settings, '// keep me\n{\n  "editor.fontSize": 14\n}\n')
    await svc.setValue(UserDataFile.Settings, ['editor.fontSize'], 22)
    const after = await svc.read(UserDataFile.Settings)
    expect(after).toContain('// keep me')
    expect(after).toContain('22')
    expect(after).not.toContain('"editor.fontSize": 14')
    svc.dispose()
  })

  it('getFileUri() returns null for ProjectSettings when no workspace is open', async () => {
    const ws = new FakeWorkspace()
    const svc = new UserDataMainService(ws as never)
    expect(await svc.getFileUri(UserDataFile.ProjectSettings)).toBeNull()
    svc.dispose()
  })

  it('does not create .vscode dir when reading VSCodeSettings of a workspace without one', async () => {
    const ws = new FakeWorkspace()
    const folder = join(tmp, 'project')
    await fs.mkdir(folder, { recursive: true })
    const svc = new UserDataMainService(ws as never)
    ws.fire({ folder: URI.file(folder), name: 'project' })
    // Give the install/watch microtasks a tick.
    await new Promise((r) => setTimeout(r, 20))
    expect(await svc.read(UserDataFile.VSCodeSettings)).toBe('')
    await expect(fs.stat(join(folder, '.vscode'))).rejects.toMatchObject({ code: 'ENOENT' })
    svc.dispose()
  })

  it('reads an existing .vscode/settings.json', async () => {
    const ws = new FakeWorkspace()
    const folder = join(tmp, 'project2')
    await fs.mkdir(join(folder, '.vscode'), { recursive: true })
    await fs.writeFile(
      join(folder, '.vscode', 'settings.json'),
      '{"files.exclude":{"**/x":true}}\n',
    )
    const svc = new UserDataMainService(ws as never)
    ws.fire({ folder: URI.file(folder), name: 'project2' })
    await new Promise((r) => setTimeout(r, 20))
    expect(await svc.read(UserDataFile.VSCodeSettings)).toContain('files.exclude')
    svc.dispose()
  })

  it('write() and setValue() refuse to touch VSCodeSettings (read-only)', async () => {
    const ws = new FakeWorkspace()
    const folder = join(tmp, 'project3')
    await fs.mkdir(join(folder, '.vscode'), { recursive: true })
    await fs.writeFile(join(folder, '.vscode', 'settings.json'), '{}\n')
    const svc = new UserDataMainService(ws as never)
    ws.fire({ folder: URI.file(folder), name: 'project3' })
    await new Promise((r) => setTimeout(r, 20))
    await expect(svc.write(UserDataFile.VSCodeSettings, '{"a":1}')).rejects.toThrow()
    expect(await svc.setValue(UserDataFile.VSCodeSettings, ['a'], 1)).toBe(false)
    expect(await svc.read(UserDataFile.VSCodeSettings)).toBe('{}\n')
    svc.dispose()
  })

  it('fires a self-write change so open editors reload after setValue()', async () => {
    const ws = new FakeWorkspace()
    const svc = new UserDataMainService(ws as never)
    const events: IUserDataFileChange[] = []
    svc.onDidChangeFile((e) => events.push(e))

    await svc.setValue(UserDataFile.Settings, ['foo'], 1)
    // Past the self-write suppress window + flush debounce: the fs.watch event
    // is swallowed, leaving only the explicit self-write fire.
    await new Promise((r) => setTimeout(r, 400))

    const settings = events.filter((e) => e.file === UserDataFile.Settings)
    expect(settings).toHaveLength(1)
    expect(settings[0]!.source).toBe('self')
    svc.dispose()
  })

  it('fires an external change when the file is edited from outside', async () => {
    const ws = new FakeWorkspace()
    const svc = new UserDataMainService(ws as never)
    // Seed the file so the watcher is armed, settling any self-write first.
    await svc.write(UserDataFile.Settings, '{}\n')
    await new Promise((r) => setTimeout(r, 400))

    const events: IUserDataFileChange[] = []
    svc.onDidChangeFile((e) => events.push(e))

    await fs.writeFile(join(currentUserData, 'settings.json'), '{"foo":2}\n')
    await new Promise((r) => setTimeout(r, 400))

    const settings = events.filter((e) => e.file === UserDataFile.Settings)
    expect(settings.length).toBeGreaterThanOrEqual(1)
    expect(settings.every((e) => e.source === 'external')).toBe(true)
    svc.dispose()
  })
})
