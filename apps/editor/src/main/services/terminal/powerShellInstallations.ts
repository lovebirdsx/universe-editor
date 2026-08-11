/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PowerShell (pwsh) installation discovery — a trimmed port of VSCode's
 *  src/vs/base/node/powershell.ts. Produces the ordered candidate list for the
 *  auto-detected "PowerShell" terminal profile; existence checks happen in the
 *  caller's fallback-chain validation, so this module only *enumerates* paths.
 *--------------------------------------------------------------------------------------------*/

export interface IPowerShellInstallDeps {
  existsFile(path: string): Promise<boolean>
  existsDirectory(path: string): Promise<boolean>
  readdir(path: string): Promise<string[]>
  env: NodeJS.ProcessEnv
  processArch: string
}

// parseInt("7-preview") would return 7, so version dirs must be validated first.
const IntRegex = /^\d+$/
const PwshMsixRegex = /^Microsoft\.PowerShell_.*/
const PwshPreviewMsixRegex = /^Microsoft\.PowerShellPreview_.*/

const enum Arch {
  x64,
  x86,
  ARM,
}

function processArchOf(arch: string): Arch {
  switch (arch) {
    case 'ia32':
      return Arch.x86
    case 'arm':
    case 'arm64':
      return Arch.ARM
    default:
      return Arch.x64
  }
}

function osArchOf(env: NodeJS.ProcessEnv): Arch {
  if (env['PROCESSOR_ARCHITEW6432']) {
    return env['PROCESSOR_ARCHITEW6432'] === 'ARM64' ? Arch.ARM : Arch.x64
  }
  if (env['PROCESSOR_ARCHITECTURE'] === 'ARM64') return Arch.ARM
  if (env['PROCESSOR_ARCHITECTURE'] === 'X86') return Arch.x86
  return Arch.x64
}

function getProgramFilesPath(
  deps: IPowerShellInstallDeps,
  useAlternateBitness: boolean,
): string | null {
  if (!useAlternateBitness) {
    return deps.env['ProgramFiles'] || null
  }
  // A 64-bit process looking for 32-bit Program Files
  if (processArchOf(deps.processArch) === Arch.x64) {
    return deps.env['ProgramFiles(X86)'] || null
  }
  // A 32-bit process looking for 64-bit Program Files
  if (osArchOf(deps.env) === Arch.x64) {
    return deps.env['ProgramW6432'] || null
  }
  return null
}

async function findPSCoreWindowsInstallation(
  deps: IPowerShellInstallDeps,
  options: { useAlternateBitness?: boolean; findPreview?: boolean } = {},
): Promise<string | null> {
  const programFilesPath = getProgramFilesPath(deps, options.useAlternateBitness ?? false)
  if (!programFilesPath) return null

  const baseDir = `${programFilesPath}\\PowerShell`
  if (!(await deps.existsDirectory(baseDir))) return null

  let highestSeenVersion = -1
  let pwshExePath: string | null = null
  for (const item of await deps.readdir(baseDir)) {
    let currentVersion = -1
    if (options.findPreview) {
      // Looking for something like "7-preview"
      const dashIndex = item.indexOf('-')
      if (dashIndex < 0) continue
      const intPart = item.substring(0, dashIndex)
      if (!IntRegex.test(intPart) || item.substring(dashIndex + 1) !== 'preview') continue
      currentVersion = parseInt(intPart, 10)
    } else {
      // Looking for a directory like "6" or "7"
      if (!IntRegex.test(item)) continue
      currentVersion = parseInt(item, 10)
    }

    if (currentVersion <= highestSeenVersion) continue

    const exePath = `${baseDir}\\${item}\\pwsh.exe`
    if (!(await deps.existsFile(exePath))) continue

    pwshExePath = exePath
    highestSeenVersion = currentVersion
  }

  return pwshExePath
}

async function findPSCoreMsix(
  deps: IPowerShellInstallDeps,
  findPreview: boolean,
): Promise<string | null> {
  const localAppData = deps.env['LOCALAPPDATA']
  if (!localAppData) return null

  const msixAppDir = `${localAppData}\\Microsoft\\WindowsApps`
  if (!(await deps.existsDirectory(msixAppDir))) return null

  const regex = findPreview ? PwshPreviewMsixRegex : PwshMsixRegex
  for (const subdir of await deps.readdir(msixAppDir)) {
    if (regex.test(subdir)) {
      return `${msixAppDir}\\${subdir}\\pwsh.exe`
    }
  }
  return null
}

/**
 * Enumerate all well-known pwsh.exe candidates in priority order (stable →
 * x86 → Store → dotnet tool → preview → Store preview → x86 preview → scoop →
 * PATH), mirroring VSCode's enumerateDefaultPowerShellInstallations plus a PATH
 * lookup. Paths are NOT verified to exist; the caller's fallback-chain
 * validation does that.
 * Windows PowerShell (System32) is appended as the last-resort candidate so
 * the "PowerShell" profile still resolves on machines without pwsh.
 */
export async function enumeratePowerShellCandidates(
  deps: IPowerShellInstallDeps,
): Promise<string[]> {
  const candidates: string[] = []

  const stable = await findPSCoreWindowsInstallation(deps)
  if (stable) candidates.push(stable)

  const stableAltBitness = await findPSCoreWindowsInstallation(deps, { useAlternateBitness: true })
  if (stableAltBitness) candidates.push(stableAltBitness)

  const msix = await findPSCoreMsix(deps, false)
  if (msix) candidates.push(msix)

  const home = deps.env['USERPROFILE']
  if (home) candidates.push(`${home}\\.dotnet\\tools\\pwsh.exe`)

  const preview = await findPSCoreWindowsInstallation(deps, { findPreview: true })
  if (preview) candidates.push(preview)

  const previewMsix = await findPSCoreMsix(deps, true)
  if (previewMsix) candidates.push(previewMsix)

  const previewAltBitness = await findPSCoreWindowsInstallation(deps, {
    useAlternateBitness: true,
    findPreview: true,
  })
  if (previewAltBitness) candidates.push(previewAltBitness)

  if (home) candidates.push(`${home}\\scoop\\apps\\pwsh\\current\\pwsh.exe`)

  // Bare name resolved against PATH by the caller's fallback-chain validation:
  // catches installs outside the well-known roots (e.g. pwsh on another drive)
  // as long as the installer added it to PATH.
  candidates.push('pwsh.exe')

  // Last resort: the Windows-builtin Windows PowerShell, so the "PowerShell"
  // profile resolves even when no pwsh is installed. Sysnative redirects a
  // 32-bit process to the 64-bit System32 (PSReadline requires it, see
  // microsoft/vscode#27915).
  const windir = deps.env['windir'] ?? 'C:\\Windows'
  const is32On64 = deps.env['PROCESSOR_ARCHITEW6432'] !== undefined
  candidates.push(
    `${windir}\\${is32On64 ? 'Sysnative' : 'System32'}\\WindowsPowerShell\\v1.0\\powershell.exe`,
  )

  return candidates
}
