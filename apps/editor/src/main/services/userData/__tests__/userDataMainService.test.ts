import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Emitter, type Event, UserDataFile, type IWorkspace } from '@universe-editor/platform'

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
})
