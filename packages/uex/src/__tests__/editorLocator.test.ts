import { describe, it, expect } from 'vitest'
import {
  locateEditor,
  parseRegUninstallInstallLocation,
  type EditorLocatorDeps,
} from '../lib/editorLocator.js'
import { UexError } from '../errors.js'

function deps(overrides: Partial<EditorLocatorDeps> = {}): EditorLocatorDeps {
  return {
    platform: 'win32',
    env: {},
    exists: () => false,
    which: () => null,
    regInstallLocation: () => null,
    ...overrides,
  }
}

const existsOnly =
  (paths: readonly string[]) =>
  (p: string): boolean =>
    paths.includes(p)

describe('locateEditor', () => {
  it('prefers --editor-path and hard-fails when it does not exist', () => {
    expect(
      locateEditor({ flagPath: 'C:/editor/Universe Editor.exe' }, deps({ exists: () => true })),
    ).toEqual({ exePath: 'C:/editor/Universe Editor.exe', source: 'flag' })
    expect(() => locateEditor({ flagPath: 'C:/nope.exe' }, deps())).toThrow(UexError)
  })

  it('prefers UNIVERSE_EDITOR_PATH over platform probing', () => {
    const found = locateEditor(
      {},
      deps({
        env: { UNIVERSE_EDITOR_PATH: 'D:/tools/Universe Editor.exe' },
        exists: existsOnly(['D:/tools/Universe Editor.exe']),
        which: () => 'C:/should/not/win/ue.cmd',
      }),
    )
    expect(found).toEqual({ exePath: 'D:/tools/Universe Editor.exe', source: 'env' })
  })

  it('hard-fails when UNIVERSE_EDITOR_PATH points nowhere', () => {
    expect(() => locateEditor({}, deps({ env: { UNIVERSE_EDITOR_PATH: 'D:/gone.exe' } }))).toThrow(
      UexError,
    )
  })

  it('win32: resolves ue.cmd on PATH back to the sibling exe', () => {
    const found = locateEditor(
      {},
      deps({
        which: (cmd) =>
          cmd === 'ue.cmd'
            ? 'C:\\Users\\me\\AppData\\Local\\Programs\\Universe Editor\\bin\\ue.cmd'
            : null,
        exists: (p) => p.endsWith('Universe Editor.exe'),
      }),
    )
    expect(found?.source).toBe('path')
    expect(found?.exePath.replace(/\//g, '\\')).toBe(
      'C:\\Users\\me\\AppData\\Local\\Programs\\Universe Editor\\Universe Editor.exe',
    )
  })

  it('win32: falls back to the per-user install dir under LOCALAPPDATA', () => {
    const localAppData = 'C:\\Users\\me\\AppData\\Local'
    const exe = `${localAppData}\\Programs\\Universe Editor\\Universe Editor.exe`
    const found = locateEditor(
      {},
      deps({
        env: { LOCALAPPDATA: localAppData },
        exists: (p) => p.replace(/\//g, '\\') === exe,
      }),
    )
    expect(found?.source).toBe('install-dir')
  })

  it('win32: falls back to the registry InstallLocation', () => {
    const found = locateEditor(
      {},
      deps({
        regInstallLocation: () => 'D:\\Custom\\Install',
        exists: (p) => p.replace(/\//g, '\\') === 'D:\\Custom\\Install\\Universe Editor.exe',
      }),
    )
    expect(found?.source).toBe('registry')
  })

  it('win32: returns null when nothing pans out', () => {
    expect(locateEditor({}, deps())).toBeNull()
  })

  it('darwin: probes /Applications before PATH', () => {
    const appExe = '/Applications/Universe Editor.app/Contents/MacOS/Universe Editor'
    const found = locateEditor(
      {},
      deps({
        platform: 'darwin',
        // Candidates are built with the host's path.join — compare slash-insensitively.
        exists: (p) => p.replace(/\\/g, '/') === appExe,
      }),
    )
    expect(found?.exePath.replace(/\\/g, '/')).toBe(appExe)
    expect(found?.source).toBe('app-bundle')
  })

  it('linux: looks up universe-editor then ue on PATH', () => {
    const found = locateEditor(
      {},
      deps({
        platform: 'linux',
        which: (cmd) => (cmd === 'universe-editor' ? '/usr/local/bin/universe-editor' : null),
        exists: existsOnly(['/usr/local/bin/universe-editor']),
      }),
    )
    expect(found).toEqual({ exePath: '/usr/local/bin/universe-editor', source: 'path' })
  })
})

describe('parseRegUninstallInstallLocation', () => {
  it('parses English-locale output', () => {
    const output = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\abc123',
      '    DisplayName    REG_SZ    Universe Editor',
      '    InstallLocation    REG_SZ    C:\\Users\\me\\AppData\\Local\\Programs\\Universe Editor',
      '',
    ].join('\r\n')
    expect(parseRegUninstallInstallLocation(output)).toBe(
      'C:\\Users\\me\\AppData\\Local\\Programs\\Universe Editor',
    )
  })

  it('parses output with localized surrounding noise', () => {
    const output = '乱码表头\r\n    InstallLocation    REG_SZ    D:\\Apps\\Universe Editor\r\n'
    expect(parseRegUninstallInstallLocation(output)).toBe('D:\\Apps\\Universe Editor')
  })

  it('returns null without a match', () => {
    expect(parseRegUninstallInstallLocation('nothing here')).toBeNull()
  })
})
