import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let currentUserData = ''

vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => {
      if (key === 'userData') return currentUserData
      throw new Error(`unexpected key: ${key}`)
    },
  },
  BrowserWindow: {
    getFocusedWindow: () => null,
    getAllWindows: () => [],
  },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
  },
}))

const { ConfigLocationMainService } = await import('../configLocationMainService.js')

interface FakeEnv {
  userDataDir: string
  configDir: string
  configDirOrigin: string
}

function makeEnv(over: Partial<FakeEnv> = {}): FakeEnv {
  return {
    userDataDir: currentUserData,
    configDir: over.configDir ?? currentUserData,
    configDirOrigin: over.configDirOrigin ?? 'default',
    ...over,
  }
}

describe('ConfigLocationMainService', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), 'ued-cfgloc-'))
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

  it('reports default origin pointing at userData', async () => {
    const svc = new ConfigLocationMainService(makeEnv() as never)
    const info = await svc.getInfo()
    expect(info.dir).toBe(currentUserData)
    expect(info.origin).toBe('default')
    expect(info.locked).toBe(false)
    svc.dispose()
  })

  it('locks when origin is cli/env', async () => {
    const svc = new ConfigLocationMainService(
      makeEnv({ configDir: '/forced', configDirOrigin: 'cli' }) as never,
    )
    expect((await svc.getInfo()).locked).toBe(true)
    expect(await svc.setConfigDir('/other', false)).toBe(false)
    expect(await svc.resetToDefault()).toBe(false)
    svc.dispose()
  })

  it('setConfigDir writes the pointer, fires the event, and copies on request', async () => {
    await fs.writeFile(join(currentUserData, 'settings.json'), '{"a":1}\n')
    await fs.writeFile(join(currentUserData, 'keybindings.json'), '[]\n')
    const svc = new ConfigLocationMainService(makeEnv() as never)
    const fired: string[] = []
    svc.onDidChangeConfigDir((d) => fired.push(d))

    const target = join(tmp, 'myconfig')
    expect(await svc.setConfigDir(target, true)).toBe(true)

    expect(fired).toEqual([target])
    expect(svc.currentDir).toBe(target)
    // Pointer persisted.
    const pointer = JSON.parse(
      await fs.readFile(join(currentUserData, 'config-location.json'), 'utf8'),
    )
    expect(pointer).toEqual({ configDir: target })
    // Existing files copied.
    expect(await fs.readFile(join(target, 'settings.json'), 'utf8')).toBe('{"a":1}\n')
    expect(await fs.readFile(join(target, 'keybindings.json'), 'utf8')).toBe('[]\n')

    const info = await svc.getInfo()
    expect(info.dir).toBe(target)
    expect(info.origin).toBe('file')
    svc.dispose()
  })

  it('setConfigDir without copy leaves the target empty', async () => {
    await fs.writeFile(join(currentUserData, 'settings.json'), '{"a":1}\n')
    const svc = new ConfigLocationMainService(makeEnv() as never)
    const target = join(tmp, 'empty')
    await svc.setConfigDir(target, false)
    await expect(fs.stat(join(target, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    svc.dispose()
  })

  it('copy never overwrites a file already in the target', async () => {
    await fs.writeFile(join(currentUserData, 'settings.json'), '{"from":"userData"}\n')
    const target = join(tmp, 'pre')
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(join(target, 'settings.json'), '{"from":"target"}\n')
    const svc = new ConfigLocationMainService(makeEnv() as never)
    await svc.setConfigDir(target, true)
    expect(await fs.readFile(join(target, 'settings.json'), 'utf8')).toBe('{"from":"target"}\n')
    svc.dispose()
  })

  it('isDirNonEmpty reflects directory contents', async () => {
    const svc = new ConfigLocationMainService(makeEnv() as never)
    const missing = join(tmp, 'nope')
    expect(await svc.isDirNonEmpty(missing)).toBe(false)
    const empty = join(tmp, 'empty-dir')
    await fs.mkdir(empty, { recursive: true })
    expect(await svc.isDirNonEmpty(empty)).toBe(false)
    await fs.writeFile(join(empty, 'x'), 'x')
    expect(await svc.isDirNonEmpty(empty)).toBe(true)
    svc.dispose()
  })

  it('resetToDefault removes the pointer and reverts to userData', async () => {
    const svc = new ConfigLocationMainService(
      makeEnv({ configDir: join(tmp, 'custom'), configDirOrigin: 'file' }) as never,
    )
    await fs.writeFile(join(currentUserData, 'config-location.json'), '{"configDir":"x"}\n')
    const fired: string[] = []
    svc.onDidChangeConfigDir((d) => fired.push(d))

    expect(await svc.resetToDefault()).toBe(true)
    expect(svc.currentDir).toBe(currentUserData)
    expect(fired).toEqual([currentUserData])
    await expect(fs.stat(join(currentUserData, 'config-location.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    svc.dispose()
  })
})
