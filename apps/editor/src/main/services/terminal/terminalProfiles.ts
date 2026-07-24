/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  detectAvailableProfiles — a trimmed port of VSCode's
 *  src/vs/platform/terminal/node/terminalProfiles.ts.
 *
 *  Pure function with every OS dependency injected (fs / execFile / env / platform),
 *  so unit tests can simulate any machine layout on any host. Detection never
 *  throws: any unexpected failure degrades to "no profiles" and the renderer
 *  falls back to the plain system-shell spawn path.
 *--------------------------------------------------------------------------------------------*/

import type {
  ITerminalProfile,
  ITerminalProfileConfigValue,
  ITerminalProfilesRequest,
} from '../../../shared/ipc/terminalService.js'
import { enumeratePowerShellCandidates } from './powerShellInstallations.js'

export interface ITerminalProfilesFsProvider {
  existsFile(path: string): Promise<boolean>
  readFile(path: string): Promise<Buffer>
  existsDirectory(path: string): Promise<boolean>
  readdir(path: string): Promise<string[]>
}

export interface ITerminalProfilesDeps {
  fs: ITerminalProfilesFsProvider
  /**
   * Direct executable spawn (no shell), used for WSL distro enumeration only.
   * The implementation MUST close/ignore the child's stdin and MUST kill the
   * child itself on `timeout`: wsl.exe blocks reading stdin when it is a pipe
   * that nobody closes, and a shell-wrapped spawn would only kill the shell,
   * orphaning wsl.exe with inherited pipe handles (which then wedges
   * Playwright's `app.close()` in e2e and leaks processes in production).
   */
  execFile(
    file: string,
    args: readonly string[],
    options: { encoding: BufferEncoding; timeout: number; env: NodeJS.ProcessEnv },
  ): Promise<string>
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  /** Windows build number (third segment of os.release()); WSL needs >= 19041. */
  windowsBuildNumber: number
  processArch: string
  /** Optional diagnostic sink for detection failures. */
  log?: (message: string) => void
}

/**
 * Internal profile shape: beyond the config DTO this also supports `source`
 * (well-known auto-detected candidate chains) and the isAutoDetected marker.
 */
interface IUnresolvedProfile {
  path?: string | string[]
  args?: string[]
  env?: Record<string, string>
  source?: 'PowerShell' | 'Git Bash'
  isAutoDetected?: boolean
}

const UnixShellsPath = '/etc/shells'
const WSL_TIMEOUT_MS = 1000
/** WSL 2 shipped in the May 2020 Update; that's where `wsl.exe -d` came from. */
const MinWslBuildNumber = 19041

function basename(p: string): string {
  const m = /[^\\/]+$/.exec(p)
  return m ? m[0] : p
}

function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i > 0 ? p.slice(0, i) : p
}

export async function detectAvailableProfiles(
  request: ITerminalProfilesRequest,
  deps: ITerminalProfilesDeps,
): Promise<ITerminalProfile[]> {
  try {
    if (deps.platform === 'win32') {
      return await detectAvailableWindowsProfiles(request, deps)
    }
    return await detectAvailableUnixProfiles(request, deps)
  } catch (err) {
    deps.log?.(`profile detection failed: ${(err as Error).message}`)
    return []
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

async function detectAvailableWindowsProfiles(
  request: ITerminalProfilesRequest,
  deps: ITerminalProfilesDeps,
): Promise<ITerminalProfile[]> {
  // Point to Sysnative when a 32-bit process runs on 64-bit Windows — the
  // System32 redirect otherwise hides the 64-bit shells (microsoft/vscode#27915).
  const windir = deps.env['windir'] ?? 'C:\\Windows'
  const system32Path = `${windir}\\${deps.env['PROCESSOR_ARCHITEW6432'] !== undefined ? 'Sysnative' : 'System32'}`
  const homeDrive = deps.env['HOMEDRIVE'] ?? 'C:'

  const detected = new Map<string, IUnresolvedProfile>()
  detected.set('PowerShell', { source: 'PowerShell', isAutoDetected: true })
  detected.set('Windows PowerShell', {
    path: `${system32Path}\\WindowsPowerShell\\v1.0\\powershell.exe`,
    isAutoDetected: true,
  })
  detected.set('Git Bash', { source: 'Git Bash', isAutoDetected: true })
  detected.set('Command Prompt', { path: `${system32Path}\\cmd.exe`, isAutoDetected: true })
  detected.set('Cygwin', {
    path: [`${homeDrive}\\cygwin64\\bin\\bash.exe`, `${homeDrive}\\cygwin\\bin\\bash.exe`],
    args: ['--login'],
    isAutoDetected: true,
  })
  detected.set('bash (MSYS2)', {
    path: `${homeDrive}\\msys64\\usr\\bin\\bash.exe`,
    args: ['--login', '-i'],
    // CHERE_INVOKING retains the current working directory
    env: { CHERE_INVOKING: '1' },
    isAutoDetected: true,
  })
  const cmderRoot = deps.env['CMDER_ROOT']
  if (cmderRoot) {
    detected.set('Cmder', {
      path: `${system32Path}\\cmd.exe`,
      args: ['/K', `${cmderRoot}\\vendor\\bin\\vscode_init.cmd`],
      isAutoDetected: true,
    })
  }

  applyConfigProfiles(detected, request.profiles)
  const profiles = await resolveProfiles(detected, request.defaultProfileName, deps)

  if (request.useWslProfiles !== false && deps.windowsBuildNumber >= MinWslBuildNumber) {
    profiles.push(
      ...(await getWslProfiles(
        `${system32Path}\\wsl.exe`,
        request.defaultProfileName,
        request.profiles,
        deps,
      )),
    )
  }
  return profiles
}

/**
 * Git Bash candidate chain (VSCode getGitBashPaths): a git.exe found on PATH
 * reveals the install dir two levels up (`<installdir>\cmd\git.exe`); then the
 * well-known install roots; then scoop's non-standard layout.
 */
async function getGitBashCandidates(deps: ITerminalProfilesDeps): Promise<string[]> {
  const gitDirs = new Set<string>()

  const gitExe = await findExecutable('git.exe', deps)
  if (gitExe) {
    // git.exe lives at <installdir>\cmd\git.exe; candidates are built from the
    // install root's parent (VSCode resolve(gitExeDir, '../..')).
    gitDirs.add(dirname(dirname(dirname(gitExe))))
  }
  const addDir = (dir: string | undefined) => {
    if (dir) gitDirs.add(dir)
  }
  addDir(deps.env['ProgramW6432'])
  addDir(deps.env['ProgramFiles'])
  addDir(deps.env['ProgramFiles(X86)'])
  const localAppData = deps.env['LocalAppData']
  if (localAppData) addDir(`${localAppData}\\Program`)

  const candidates: string[] = []
  for (const gitDir of gitDirs) {
    candidates.push(
      `${gitDir}\\Git\\bin\\bash.exe`,
      `${gitDir}\\Git\\usr\\bin\\bash.exe`,
      // Git for Windows SDK layout
      `${gitDir}\\usr\\bin\\bash.exe`,
    )
  }

  const home = deps.env['UserProfile']
  if (home) {
    candidates.push(`${home}\\scoop\\apps\\git\\current\\bin\\bash.exe`)
    candidates.push(`${home}\\scoop\\apps\\git-with-openssh\\current\\bin\\bash.exe`)
  }
  return candidates
}

async function getWslProfiles(
  wslPath: string,
  defaultProfileName: string | undefined,
  configProfiles: Record<string, ITerminalProfileConfigValue> | undefined,
  deps: ITerminalProfilesDeps,
): Promise<ITerminalProfile[]> {
  let distroOutput: string
  try {
    // wsl.exe output is utf16le by default; force it in case the user enabled
    // WSL_UTF8 (microsoft/vscode#276253).
    distroOutput = await deps.execFile('wsl.exe', ['-l', '-q'], {
      encoding: 'utf16le',
      timeout: WSL_TIMEOUT_MS,
      env: { ...deps.env, WSL_UTF8: '0' },
    })
  } catch (err) {
    deps.log?.(`WSL distro enumeration skipped: ${(err as Error).message}`)
    return []
  }
  if (!distroOutput) return []

  const profiles: ITerminalProfile[] = []
  for (const raw of distroOutput.split(/\r?\n/)) {
    const distroName = raw.trim()
    if (distroName === '') continue
    // Docker Desktop's internal distros are an implementation detail
    if (distroName.startsWith('docker-desktop')) continue

    const profileName = `${distroName} (WSL)`
    // A config entry with the same name (even null) overrides the auto entry
    if (configProfiles && Object.prototype.hasOwnProperty.call(configProfiles, profileName)) {
      continue
    }
    profiles.push({
      profileName,
      path: wslPath,
      args: ['-d', distroName],
      isDefault: profileName === defaultProfileName,
      isAutoDetected: true,
    })
  }
  return profiles
}

// ---------------------------------------------------------------------------
// Unix
// ---------------------------------------------------------------------------

async function detectAvailableUnixProfiles(
  request: ITerminalProfilesRequest,
  deps: ITerminalProfilesDeps,
): Promise<ITerminalProfile[]> {
  const detected = new Map<string, IUnresolvedProfile>()

  if (await deps.fs.existsFile(UnixShellsPath)) {
    const contents = (await deps.fs.readFile(UnixShellsPath)).toString()
    const paths = contents
      .split('\n')
      .map((e) => {
        const index = e.indexOf('#')
        return (index === -1 ? e : e.substring(0, index)).trim()
      })
      .filter((e) => e.length > 0)
    const counts = new Map<string, number>()
    for (const shellPath of paths) {
      const base = basename(shellPath)
      const count = (counts.get(base) ?? 0) + 1
      counts.set(base, count)
      const profileName = count > 1 ? `${base} (${count})` : base
      detected.set(profileName, { path: shellPath, isAutoDetected: true })
    }
  }

  applyConfigProfiles(detected, request.profiles)
  return resolveProfiles(detected, request.defaultProfileName, deps)
}

// ---------------------------------------------------------------------------
// Shared: config merge, source resolution, path validation
// ---------------------------------------------------------------------------

/**
 * Merge `terminal.integrated.profiles.{os}` into the detected map: `null`
 * removes the profile; an object overrides the fields it declares and keeps
 * the detected candidate chain for the rest (so `{ "PowerShell": { "args": … } }`
 * only changes the arguments).
 */
function applyConfigProfiles(
  detected: Map<string, IUnresolvedProfile>,
  configProfiles: Record<string, ITerminalProfileConfigValue> | undefined,
): void {
  if (!configProfiles) return
  for (const [profileName, value] of Object.entries(configProfiles)) {
    if (value === null || typeof value !== 'object') {
      detected.delete(profileName)
      continue
    }
    const existing = detected.get(profileName)
    const merged: IUnresolvedProfile = {
      ...(existing?.source !== undefined && value.path === undefined
        ? { source: existing.source }
        : {}),
      ...(existing?.isAutoDetected !== undefined
        ? { isAutoDetected: existing.isAutoDetected }
        : {}),
    }
    const path = value.path !== undefined ? value.path : existing?.path
    if (path !== undefined) merged.path = typeof path === 'string' ? path : [...path]
    const args = value.args !== undefined ? value.args : existing?.args
    if (args !== undefined) merged.args = [...args]
    const env = value.env !== undefined ? value.env : existing?.env
    if (env !== undefined) merged.env = { ...env }
    detected.set(profileName, merged)
  }
}

async function resolveProfiles(
  detected: Map<string, IUnresolvedProfile>,
  defaultProfileName: string | undefined,
  deps: ITerminalProfilesDeps,
): Promise<ITerminalProfile[]> {
  // Source-based candidate chains are resolved lazily and only once.
  let pwshCandidates: string[] | undefined
  let gitBashCandidates: string[] | undefined

  const profiles: ITerminalProfile[] = []
  for (const [profileName, profile] of detected) {
    let paths: readonly string[]
    let args = profile.args
    if (profile.source === 'PowerShell') {
      pwshCandidates ??= await enumeratePowerShellCandidates({
        existsFile: deps.fs.existsFile,
        existsDirectory: deps.fs.existsDirectory,
        readdir: deps.fs.readdir,
        env: deps.env,
        processArch: deps.processArch,
      })
      paths = pwshCandidates
    } else if (profile.source === 'Git Bash') {
      gitBashCandidates ??= await getGitBashCandidates(deps)
      paths = gitBashCandidates
      args ??= ['--login', '-i']
    } else if (profile.path !== undefined) {
      paths = Array.isArray(profile.path) ? profile.path : [profile.path]
    } else {
      continue
    }

    const resolved = await validateProfilePaths(
      profileName,
      defaultProfileName,
      paths,
      deps,
      args,
      profile.env,
      profile.isAutoDetected,
    )
    if (resolved) profiles.push(resolved)
  }
  return profiles
}

/**
 * Walk a fallback chain and return the first path that exists. A bare name
 * (no directory separator) is looked up on PATH and flagged `isFromPath`.
 */
async function validateProfilePaths(
  profileName: string,
  defaultProfileName: string | undefined,
  potentialPaths: readonly string[],
  deps: ITerminalProfilesDeps,
  args: readonly string[] | undefined,
  env: Record<string, string> | undefined,
  isAutoDetected: boolean | undefined,
): Promise<ITerminalProfile | undefined> {
  const isDefault = profileName === defaultProfileName
  for (const candidate of potentialPaths) {
    if (candidate === '') continue

    if (basename(candidate) === candidate) {
      const found = await findExecutable(candidate, deps)
      if (found) {
        return {
          profileName,
          path: found,
          isDefault,
          isAutoDetected: isAutoDetected ?? false,
          isFromPath: true,
          ...(args ? { args } : {}),
          ...(env ? { env } : {}),
        }
      }
      continue
    }

    if (await deps.fs.existsFile(candidate)) {
      return {
        profileName,
        path: candidate,
        isDefault,
        isAutoDetected: isAutoDetected ?? false,
        ...(args ? { args } : {}),
        ...(env ? { env } : {}),
      }
    }
  }
  return undefined
}

/**
 * Look a bare command name up on PATH (VSCode findExecutable). On Windows the
 * PATHEXT extensions are tried unless the command already carries one.
 */
async function findExecutable(
  command: string,
  deps: ITerminalProfilesDeps,
): Promise<string | undefined> {
  const pathEnv = deps.env['PATH']
  if (!pathEnv) return undefined
  const isWindows = deps.platform === 'win32'
  const dirs = pathEnv.split(isWindows ? ';' : ':').filter((d) => d.length > 0)

  let candidates: readonly string[]
  if (isWindows) {
    const pathExts = (deps.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';')
    const hasExtension = pathExts.some((ext) => command.toUpperCase().endsWith(ext.toUpperCase()))
    candidates = hasExtension ? [command] : pathExts.map((ext) => `${command}${ext}`)
  } else {
    candidates = [command]
  }

  for (const dir of dirs) {
    for (const candidate of candidates) {
      const fullPath = `${dir}${isWindows ? '\\' : '/'}${candidate}`
      if (await deps.fs.existsFile(fullPath)) return fullPath
    }
  }
  return undefined
}
