import { describe, expect, it, vi } from 'vitest'
import { win32 as pathWin32 } from 'node:path'
import { applyProductIdentity, resolveProductIdentity, type ResolveEnv } from '../productPaths.js'

const winBase: ResolveEnv = {
  isDev: false,
  isE2E: false,
  platform: 'win32',
  appData: 'C:\\Users\\u\\AppData\\Roaming',
  home: 'C:\\Users\\u',
}

describe('resolveProductIdentity', () => {
  it('release on win32 uses base productName and appId', () => {
    const id = resolveProductIdentity(winBase)
    expect(id.productName).toBe('Universe Editor')
    expect(id.appUserModelId).toBe('io.universe.editor')
    expect(id.userDataDir).toBe(pathWin32.join(winBase.appData!, 'Universe Editor'))
  })

  it('dev on win32 appends - Dev', () => {
    const id = resolveProductIdentity({ ...winBase, isDev: true })
    expect(id.productName).toBe('Universe Editor - Dev')
    expect(id.appUserModelId).toBe('io.universe.editor.dev')
    expect(id.userDataDir).toBe(pathWin32.join(winBase.appData!, 'Universe Editor - Dev'))
  })

  it('e2e wins over dev', () => {
    const id = resolveProductIdentity({ ...winBase, isDev: true, isE2E: true })
    expect(id.productName).toBe('Universe Editor - E2E')
    expect(id.appUserModelId).toBe('io.universe.editor.e2e')
  })

  it('override forces userDataDir but keeps productName from flavor', () => {
    const id = resolveProductIdentity({
      ...winBase,
      isDev: true,
      override: 'D:\\tmp\\ue',
    })
    expect(id.userDataDir).toBe('D:\\tmp\\ue')
    expect(id.productName).toBe('Universe Editor - Dev')
  })

  it('darwin uses Library/Application Support', () => {
    const id = resolveProductIdentity({
      isDev: false,
      isE2E: false,
      platform: 'darwin',
      home: '/Users/u',
    })
    expect(id.userDataDir).toBe('/Users/u/Library/Application Support/Universe Editor')
  })

  it('linux honors XDG_CONFIG_HOME', () => {
    const id = resolveProductIdentity({
      isDev: false,
      isE2E: false,
      platform: 'linux',
      home: '/home/u',
      xdgConfigHome: '/home/u/.config-custom',
    })
    expect(id.userDataDir).toBe('/home/u/.config-custom/Universe Editor')
  })

  it('linux falls back to ~/.config when XDG unset', () => {
    const id = resolveProductIdentity({
      isDev: false,
      isE2E: false,
      platform: 'linux',
      home: '/home/u',
    })
    expect(id.userDataDir).toBe('/home/u/.config/Universe Editor')
  })

  it('win32 falls back to USERPROFILE\\AppData\\Roaming when APPDATA missing', () => {
    const id = resolveProductIdentity({
      isDev: false,
      isE2E: false,
      platform: 'win32',
      home: 'C:\\Users\\u',
    })
    expect(id.userDataDir).toBe(
      pathWin32.join('C:\\Users\\u', 'AppData', 'Roaming', 'Universe Editor'),
    )
  })
})

describe('applyProductIdentity', () => {
  it('calls setName + setPath, and setAppUserModelId only on win32', () => {
    const app = {
      setName: vi.fn(),
      setPath: vi.fn(),
      setAppUserModelId: vi.fn(),
    }
    const id = resolveProductIdentity(winBase)
    applyProductIdentity(app as unknown as Electron.App, id)
    expect(app.setName).toHaveBeenCalledWith('Universe Editor')
    expect(app.setPath).toHaveBeenCalledWith('userData', id.userDataDir)
    // setAppUserModelId is gated on actual process.platform; assert it was either
    // called with the right id on win32, or not called elsewhere.
    if (process.platform === 'win32') {
      expect(app.setAppUserModelId).toHaveBeenCalledWith('io.universe.editor')
    } else {
      expect(app.setAppUserModelId).not.toHaveBeenCalled()
    }
  })
})

describe('resolveProductIdentity (override semantics)', () => {
  it('cli --user-data-dir override is honored over flavor default', () => {
    const id = resolveProductIdentity({ ...winBase, isE2E: true, override: 'D:\\tmp\\e2e-1234' })
    expect(id.userDataDir).toBe('D:\\tmp\\e2e-1234')
    expect(id.productName).toBe('Universe Editor - E2E')
  })
})
