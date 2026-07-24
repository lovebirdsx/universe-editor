/*---------------------------------------------------------------------------------------------
 *  Tests for powerShellInstallations.enumeratePowerShellCandidates.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  enumeratePowerShellCandidates,
  type IPowerShellInstallDeps,
} from '../powerShellInstallations.js'

class FakeFs {
  private readonly _files = new Set<string>()
  private readonly _dirs = new Set<string>()

  addFile(path: string): this {
    this._files.add(path)
    return this
  }

  addDir(path: string): this {
    this._dirs.add(path)
    return this
  }

  get existsFile() {
    return (p: string) => Promise.resolve(this._files.has(p))
  }
  get existsDirectory() {
    return (p: string) => Promise.resolve(this._dirs.has(p))
  }
  get readdir() {
    return (p: string) => {
      const out = new Set<string>()
      const prefix = `${p}\\`
      const collect = (full: string) => {
        if (!full.startsWith(prefix)) return
        const rest = full.slice(prefix.length)
        if (rest.length > 0) out.add(rest.split('\\')[0]!)
      }
      for (const f of this._files) collect(f)
      for (const d of this._dirs) collect(d)
      return Promise.resolve([...out])
    }
  }
}

const BASE_ENV: NodeJS.ProcessEnv = {
  windir: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(X86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
  USERPROFILE: 'C:\\Users\\tester',
}

function makeDeps(fs: FakeFs, env: NodeJS.ProcessEnv = BASE_ENV): IPowerShellInstallDeps {
  return {
    existsFile: fs.existsFile,
    existsDirectory: fs.existsDirectory,
    readdir: fs.readdir,
    env,
    processArch: 'x64',
  }
}

describe('enumeratePowerShellCandidates', () => {
  it('picks the highest numeric version directory under Program Files', async () => {
    const fs = new FakeFs()
      .addDir('C:\\Program Files\\PowerShell')
      .addFile('C:\\Program Files\\PowerShell\\6\\pwsh.exe')
      .addFile('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
      .addFile('C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe')
    const candidates = await enumeratePowerShellCandidates(makeDeps(fs))
    expect(candidates[0]).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    // preview is not part of the stable pick
    expect(candidates[0]).not.toContain('preview')
  })

  it('finds preview installs only via the preview slot', async () => {
    const fs = new FakeFs()
      .addDir('C:\\Program Files\\PowerShell')
      .addFile('C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe')
    const candidates = await enumeratePowerShellCandidates(makeDeps(fs))
    // stable slot is skipped (no numeric dir); preview shows up later in the chain
    expect(candidates).toContain('C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe')
    expect(candidates[0]).not.toBe('C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe')
  })

  it('uses ProgramW6432 for the alternate-bitness lookup on a 32-bit process', async () => {
    const fs = new FakeFs()
      .addDir('C:\\Program Files\\PowerShell')
      .addFile('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    const deps: IPowerShellInstallDeps = {
      ...makeDeps(fs),
      processArch: 'ia32',
      env: {
        ...BASE_ENV,
        PROCESSOR_ARCHITEW6432: 'AMD64',
        ProgramW6432: 'C:\\Program Files',
        'ProgramFiles(X86)': 'C:\\Program Files (x86)',
      },
    }
    const candidates = await enumeratePowerShellCandidates(deps)
    // 32-bit process: native ProgramFiles resolves via ProgramW6432
    expect(candidates[0]).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    // Sysnative fallback for Windows PowerShell
    expect(candidates[candidates.length - 1]).toContain('Sysnative')
  })

  it('matches the Store MSIX directory naming', async () => {
    const fs = new FakeFs()
      .addDir('C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps')
      .addDir(
        'C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps\\Microsoft.PowerShell_7.4_x64__8wekyb3d8bbwe',
      )
      .addDir('C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps\\Unrelated.Package_1.0')
    const candidates = await enumeratePowerShellCandidates(makeDeps(fs))
    expect(candidates).toContain(
      'C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps\\Microsoft.PowerShell_7.4_x64__8wekyb3d8bbwe\\pwsh.exe',
    )
  })

  it('always appends dotnet-tool / scoop / Windows PowerShell fallbacks', async () => {
    const candidates = await enumeratePowerShellCandidates(makeDeps(new FakeFs()))
    expect(candidates).toContain('C:\\Users\\tester\\.dotnet\\tools\\pwsh.exe')
    expect(candidates).toContain('C:\\Users\\tester\\scoop\\apps\\pwsh\\current\\pwsh.exe')
    expect(candidates[candidates.length - 1]).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
  })
})
