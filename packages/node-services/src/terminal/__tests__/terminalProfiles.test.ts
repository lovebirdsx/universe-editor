/*---------------------------------------------------------------------------------------------
 *  Tests for terminalProfiles.detectAvailableProfiles — in-memory fs/execFile/env
 *  let these simulate Windows machines on any host OS.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  detectAvailableProfiles,
  type ITerminalProfilesDeps,
  type ITerminalProfilesFsProvider,
} from '../terminalProfiles.js'
import type { ITerminalProfilesRequest } from '@universe-editor/platform'

// ---------------------------------------------------------------------------
// In-memory filesystem
// ---------------------------------------------------------------------------

class FakeFs {
  private readonly _files = new Map<string, string>()
  private readonly _dirs = new Set<string>()

  addFile(path: string, content = ''): this {
    this._files.set(path, content)
    return this
  }

  addDir(path: string): this {
    this._dirs.add(path)
    return this
  }

  get provider(): ITerminalProfilesFsProvider {
    return {
      existsFile: (p) => Promise.resolve(this._files.has(p)),
      readFile: (p) => Promise.resolve(Buffer.from(this._files.get(p) ?? '')),
      existsDirectory: (p) => Promise.resolve(this._dirs.has(p)),
      readdir: (p) => {
        // Like a real readdir: surface the first path segment below `p`,
        // whether it names a file directly or an intermediate directory.
        const out = new Set<string>()
        const prefix = `${p}\\`
        const collect = (full: string) => {
          if (!full.startsWith(prefix)) return
          const rest = full.slice(prefix.length)
          if (rest.length > 0) out.add(rest.split('\\')[0]!)
        }
        for (const f of this._files.keys()) collect(f)
        for (const d of this._dirs) collect(d)
        return Promise.resolve([...out])
      },
    }
  }
}

// ---------------------------------------------------------------------------
// Deps builders
// ---------------------------------------------------------------------------

const WIN_ENV: NodeJS.ProcessEnv = {
  windir: 'C:\\Windows',
  HOMEDRIVE: 'C:',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(X86)': 'C:\\Program Files (x86)',
  LocalAppData: 'C:\\Users\\tester\\AppData\\Local',
  LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
  UserProfile: 'C:\\Users\\tester',
  USERPROFILE: 'C:\\Users\\tester',
  PATH: 'C:\\Windows\\System32',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
}

function makeDeps(overrides: Partial<ITerminalProfilesDeps>): ITerminalProfilesDeps {
  return {
    fs: new FakeFs().provider,
    execFile: () => Promise.reject(new Error('execFile not stubbed')),
    env: {},
    platform: 'linux',
    windowsBuildNumber: 0,
    processArch: 'x64',
    ...overrides,
  }
}

function winDeps(
  fs: FakeFs,
  overrides: Partial<ITerminalProfilesDeps> = {},
): ITerminalProfilesDeps {
  return makeDeps({
    fs: fs.provider,
    env: { ...WIN_ENV },
    platform: 'win32',
    windowsBuildNumber: 19045,
    ...overrides,
  })
}

/** The standard machine: pwsh 7 in Program Files + inbox cmd/powershell. */
function standardWindowsFs(): FakeFs {
  return new FakeFs()
    .addDir('C:\\Program Files\\PowerShell')
    .addFile('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    .addFile('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    .addFile('C:\\Windows\\System32\\cmd.exe')
}

const NO_PROFILES: ITerminalProfilesRequest = {}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

describe('detectAvailableProfiles — Windows', () => {
  it('detects PowerShell, Windows PowerShell and Command Prompt in order', async () => {
    const profiles = await detectAvailableProfiles(NO_PROFILES, winDeps(standardWindowsFs()))
    expect(profiles.map((p) => p.profileName)).toEqual([
      'PowerShell',
      'Windows PowerShell',
      'Command Prompt',
    ])
    expect(profiles[0]!.path).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    expect(profiles.every((p) => p.isAutoDetected)).toBe(true)
  })

  it('walks the pwsh fallback chain when the first candidate is missing', async () => {
    // No Program Files pwsh — only the dotnet global tool installation.
    const fs = new FakeFs()
      .addFile('C:\\Users\\tester\\.dotnet\\tools\\pwsh.exe')
      .addFile('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
      .addFile('C:\\Windows\\System32\\cmd.exe')
    const profiles = await detectAvailableProfiles(NO_PROFILES, winDeps(fs))
    expect(profiles[0]!.profileName).toBe('PowerShell')
    expect(profiles[0]!.path).toBe('C:\\Users\\tester\\.dotnet\\tools\\pwsh.exe')
  })

  it('drops the PowerShell profile entirely when no candidate exists', async () => {
    const fs = new FakeFs().addFile('C:\\Windows\\System32\\cmd.exe')
    const profiles = await detectAvailableProfiles(NO_PROFILES, winDeps(fs))
    expect(profiles.map((p) => p.profileName)).toEqual(['Command Prompt'])
  })

  it('resolves the PowerShell profile from a pwsh that is only on PATH', async () => {
    // pwsh installed outside the well-known roots (e.g. another drive), with
    // only the installer-added PATH entry pointing at it.
    const fs = new FakeFs()
      .addFile('D:\\Program Files\\PowerShell\\7\\pwsh.exe')
      .addFile('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
      .addFile('C:\\Windows\\System32\\cmd.exe')
    const deps = winDeps(fs, {
      env: { ...WIN_ENV, PATH: 'C:\\Windows\\System32;D:\\Program Files\\PowerShell\\7' },
    })
    const profiles = await detectAvailableProfiles(NO_PROFILES, deps)
    const pwsh = profiles.find((p) => p.profileName === 'PowerShell')
    expect(pwsh?.path).toBe('D:\\Program Files\\PowerShell\\7\\pwsh.exe')
    expect(pwsh?.isFromPath).toBe(true)
  })

  it('uses Sysnative instead of System32 for a 32-bit process on 64-bit Windows', async () => {
    const fs = new FakeFs()
      .addFile('C:\\Windows\\Sysnative\\cmd.exe')
      .addFile('C:\\Windows\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe')
    const deps = winDeps(fs, {
      processArch: 'ia32',
      env: { ...WIN_ENV, PROCESSOR_ARCHITEW6432: 'AMD64' },
    })
    const profiles = await detectAvailableProfiles(NO_PROFILES, deps)
    const cmd = profiles.find((p) => p.profileName === 'Command Prompt')
    expect(cmd?.path).toBe('C:\\Windows\\Sysnative\\cmd.exe')
  })

  it('discovers Git Bash from a git.exe on PATH', async () => {
    // A git.exe at <root>\git\cmd\git.exe reveals <root> as the install parent;
    // the bash candidate then follows the standard "Git\bin\bash.exe" layout.
    const fs = standardWindowsFs()
      .addFile('C:\\tools\\git\\cmd\\git.exe')
      .addFile('C:\\tools\\Git\\bin\\bash.exe')
    const deps = winDeps(fs, {
      env: { ...WIN_ENV, PATH: 'C:\\Windows\\System32;C:\\tools\\git\\cmd' },
    })
    const profiles = await detectAvailableProfiles(NO_PROFILES, deps)
    const gitBash = profiles.find((p) => p.profileName === 'Git Bash')
    expect(gitBash?.path).toBe('C:\\tools\\Git\\bin\\bash.exe')
    expect(gitBash?.args).toEqual(['--login', '-i'])
  })

  it('falls back to the well-known Git install roots when git.exe is not on PATH', async () => {
    const fs = standardWindowsFs().addFile('C:\\Program Files\\Git\\bin\\bash.exe')
    const profiles = await detectAvailableProfiles(NO_PROFILES, winDeps(fs))
    expect(profiles.find((p) => p.profileName === 'Git Bash')?.path).toBe(
      'C:\\Program Files\\Git\\bin\\bash.exe',
    )
  })

  it('detects Cygwin and MSYS2 with their login args', async () => {
    const fs = standardWindowsFs()
      .addFile('C:\\cygwin64\\bin\\bash.exe')
      .addFile('C:\\msys64\\usr\\bin\\bash.exe')
    const profiles = await detectAvailableProfiles(NO_PROFILES, winDeps(fs))
    const cygwin = profiles.find((p) => p.profileName === 'Cygwin')
    expect(cygwin?.args).toEqual(['--login'])
    const msys2 = profiles.find((p) => p.profileName === 'bash (MSYS2)')
    expect(msys2?.args).toEqual(['--login', '-i'])
    expect(msys2?.env).toEqual({ CHERE_INVOKING: '1' })
  })

  it('only offers Cmder when CMDER_ROOT is set', async () => {
    const fs = standardWindowsFs()
    const without = await detectAvailableProfiles(NO_PROFILES, winDeps(fs))
    expect(without.find((p) => p.profileName === 'Cmder')).toBeUndefined()

    const withCmder = await detectAvailableProfiles(
      NO_PROFILES,
      winDeps(fs, { env: { ...WIN_ENV, CMDER_ROOT: 'C:\\tools\\cmder' } }),
    )
    const cmder = withCmder.find((p) => p.profileName === 'Cmder')
    expect(cmder?.path).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(cmder?.args?.[0]).toBe('/K')
  })

  it('marks the configured default profile', async () => {
    const profiles = await detectAvailableProfiles(
      { defaultProfileName: 'Command Prompt' },
      winDeps(standardWindowsFs()),
    )
    expect(profiles.find((p) => p.profileName === 'Command Prompt')?.isDefault).toBe(true)
    expect(profiles.find((p) => p.profileName === 'PowerShell')?.isDefault).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Windows — config merge
// ---------------------------------------------------------------------------

describe('detectAvailableProfiles — Windows config merge', () => {
  it('null removes an auto-detected profile', async () => {
    const profiles = await detectAvailableProfiles(
      { profiles: { 'Git Bash': null, 'Command Prompt': null } },
      winDeps(standardWindowsFs().addFile('C:\\Program Files\\Git\\bin\\bash.exe')),
    )
    expect(profiles.map((p) => p.profileName)).toEqual(['PowerShell', 'Windows PowerShell'])
  })

  it('overriding args keeps the detected candidate chain', async () => {
    const profiles = await detectAvailableProfiles(
      { profiles: { PowerShell: { args: ['-NoProfile'] } } },
      winDeps(standardWindowsFs()),
    )
    const pwsh = profiles.find((p) => p.profileName === 'PowerShell')
    expect(pwsh?.path).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    expect(pwsh?.args).toEqual(['-NoProfile'])
  })

  it('a config path replaces the detected chain; an array acts as fallbacks', async () => {
    const fs = standardWindowsFs().addFile('D:\\shells\\pwsh-alt.exe')
    const profiles = await detectAvailableProfiles(
      { profiles: { PowerShell: { path: ['C:\\missing\\pwsh.exe', 'D:\\shells\\pwsh-alt.exe'] } } },
      winDeps(fs),
    )
    expect(profiles.find((p) => p.profileName === 'PowerShell')?.path).toBe(
      'D:\\shells\\pwsh-alt.exe',
    )
  })

  it('adds a custom profile and validates its path', async () => {
    const fs = standardWindowsFs().addFile('C:\\tools\\nu\\nu.exe')
    const profiles = await detectAvailableProfiles(
      { profiles: { Nushell: { path: 'C:\\tools\\nu\\nu.exe' } } },
      winDeps(fs),
    )
    const nu = profiles.find((p) => p.profileName === 'Nushell')
    expect(nu?.isAutoDetected).toBe(false)
    // A custom profile with a missing path never surfaces.
    const profiles2 = await detectAvailableProfiles(
      { profiles: { Missing: { path: 'C:\\nope\\sh.exe' } } },
      winDeps(fs),
    )
    expect(profiles2.find((p) => p.profileName === 'Missing')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Windows — WSL
// ---------------------------------------------------------------------------

describe('detectAvailableProfiles — WSL', () => {
  it('adds a profile per distro and filters docker-desktop', async () => {
    const execFile = vi.fn(() => Promise.resolve('Ubuntu\r\ndocker-desktop\r\nDebian\n'))
    const profiles = await detectAvailableProfiles(
      NO_PROFILES,
      winDeps(standardWindowsFs(), { execFile }),
    )
    const wsl = profiles.filter((p) => p.profileName.endsWith('(WSL)'))
    expect(wsl.map((p) => p.profileName)).toEqual(['Ubuntu (WSL)', 'Debian (WSL)'])
    expect(wsl[0]!.path).toBe('C:\\Windows\\System32\\wsl.exe')
    expect(wsl[0]!.args).toEqual(['-d', 'Ubuntu'])
  })

  it('silently skips WSL when the enumeration fails', async () => {
    const execFile = vi.fn(() => Promise.reject(new Error('wsl not installed')))
    const profiles = await detectAvailableProfiles(
      NO_PROFILES,
      winDeps(standardWindowsFs(), { execFile }),
    )
    expect(profiles.some((p) => p.profileName.endsWith('(WSL)'))).toBe(false)
  })

  it('does not run wsl.exe when useWslProfiles is false', async () => {
    const execFile = vi.fn(() => Promise.resolve('Ubuntu\r\n'))
    await detectAvailableProfiles(
      { useWslProfiles: false },
      winDeps(standardWindowsFs(), { execFile }),
    )
    expect(execFile).not.toHaveBeenCalled()
  })

  it('skips WSL below build 19041', async () => {
    const execFile = vi.fn(() => Promise.resolve('Ubuntu\r\n'))
    await detectAvailableProfiles(
      NO_PROFILES,
      winDeps(standardWindowsFs(), { execFile, windowsBuildNumber: 18363 }),
    )
    expect(execFile).not.toHaveBeenCalled()
  })

  it('a config entry with the distro name suppresses the auto WSL profile', async () => {
    const execFile = vi.fn(() => Promise.resolve('Ubuntu\r\n'))
    const profiles = await detectAvailableProfiles(
      { profiles: { 'Ubuntu (WSL)': null } },
      winDeps(standardWindowsFs(), { execFile }),
    )
    expect(profiles.some((p) => p.profileName === 'Ubuntu (WSL)')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Unix
// ---------------------------------------------------------------------------

describe('detectAvailableProfiles — Unix', () => {
  function unixDeps(
    fs: FakeFs,
    overrides: Partial<ITerminalProfilesDeps> = {},
  ): ITerminalProfilesDeps {
    return makeDeps({
      fs: fs.provider,
      env: { PATH: '/usr/bin:/bin' },
      platform: 'linux',
      ...overrides,
    })
  }

  it('reads /etc/shells, strips comments and dedupes by basename', async () => {
    const fs = new FakeFs()
      .addFile('/bin/bash')
      .addFile('/usr/bin/bash')
      .addFile('/bin/zsh')
      .addFile(
        '/etc/shells',
        '# shells\n/bin/bash\n/usr/bin/bash\n/bin/zsh\n\n/bin/dash # comment\n',
      )
    const profiles = await detectAvailableProfiles(NO_PROFILES, unixDeps(fs))
    expect(profiles.map((p) => p.profileName)).toEqual(['bash', 'bash (2)', 'zsh'])
    // /bin/dash has no executable on disk → dropped
  })

  it('returns only config profiles when /etc/shells is absent', async () => {
    const fs = new FakeFs().addFile('/usr/local/bin/fish')
    const profiles = await detectAvailableProfiles(
      { profiles: { fish: { path: '/usr/local/bin/fish', args: ['-l'] } } },
      unixDeps(fs),
    )
    expect(profiles).toHaveLength(1)
    expect(profiles[0]!.profileName).toBe('fish')
    expect(profiles[0]!.args).toEqual(['-l'])
  })

  it('resolves a bare command name on PATH and flags isFromPath', async () => {
    const fs = new FakeFs().addFile('/usr/bin/mysh')
    const profiles = await detectAvailableProfiles(
      { profiles: { mysh: { path: 'mysh' } } },
      unixDeps(fs),
    )
    expect(profiles[0]!.path).toBe('/usr/bin/mysh')
    expect(profiles[0]!.isFromPath).toBe(true)
  })

  it('drops a bare name that is not on PATH', async () => {
    const profiles = await detectAvailableProfiles(
      { profiles: { mysh: { path: 'mysh' } } },
      unixDeps(new FakeFs()),
    )
    expect(profiles).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

describe('detectAvailableProfiles — robustness', () => {
  it('degrades to an empty list instead of throwing when the fs blows up', async () => {
    const deps = makeDeps({
      platform: 'win32',
      env: { ...WIN_ENV },
      fs: {
        existsFile: () => Promise.reject(new Error('disk on fire')),
        readFile: () => Promise.reject(new Error('disk on fire')),
        existsDirectory: () => Promise.reject(new Error('disk on fire')),
        readdir: () => Promise.reject(new Error('disk on fire')),
      },
    })
    await expect(detectAvailableProfiles(NO_PROFILES, deps)).resolves.toEqual([])
  })
})
