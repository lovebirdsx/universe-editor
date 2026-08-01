/**
 * Locates an installed Universe Editor executable for `uex dev`. Pure and
 * dependency-injected so the whole platform matrix is unit-testable; the real
 * deps are assembled in dev.ts.
 *
 * Priority: --editor-path flag > UNIVERSE_EDITOR_PATH env > platform probing.
 * The installed editor's name contains a space ("Universe Editor.exe") — every
 * candidate is existence-checked before it is returned.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { UexError } from '../errors.js'

export interface EditorLocatorDeps {
  readonly platform: 'win32' | 'darwin' | 'linux'
  readonly env: { readonly [key: string]: string | undefined }
  readonly exists: (p: string) => boolean
  /** Resolve a command on PATH (win: `where`, posix: `which`); null when absent. */
  readonly which: (cmd: string) => string | null
  /** Windows-only registry probe; other platforms pass `() => null`. */
  readonly regInstallLocation: () => string | null
}

export interface LocatedEditor {
  readonly exePath: string
  readonly source: 'flag' | 'env' | 'path' | 'install-dir' | 'registry' | 'app-bundle'
}

const PRODUCT_EXE = 'Universe Editor.exe'
const PRODUCT_APP = 'Universe Editor.app'

/** Extract InstallLocation from `reg query ... /s` output. Value names are
 *  English on every locale; only the column padding varies. */
export function parseRegUninstallInstallLocation(output: string): string | null {
  const match = /InstallLocation\s+REG_\w+\s+(.+)$/m.exec(output)
  const value = match?.[1]?.trim()
  return value ? value : null
}

function candidate(
  deps: EditorLocatorDeps,
  exePath: string | null,
  source: LocatedEditor['source'],
): LocatedEditor | null {
  return exePath !== null && deps.exists(exePath) ? { exePath, source } : null
}

export function locateEditor(
  opts: { readonly flagPath?: string | undefined },
  deps: EditorLocatorDeps,
): LocatedEditor | null {
  // Path math follows the *target* platform, not the host — the deps are
  // injectable precisely so tests can probe win32 from a posix host.
  const p = deps.platform === 'win32' ? path.win32 : path.posix
  if (opts.flagPath !== undefined) {
    if (!deps.exists(opts.flagPath)) {
      throw new UexError(`--editor-path does not exist: ${opts.flagPath}`, [
        'point it at the editor executable (e.g. "C:\\\\path\\\\to\\\\Universe Editor.exe")',
      ])
    }
    return { exePath: opts.flagPath, source: 'flag' }
  }

  const envPath = deps.env.UNIVERSE_EDITOR_PATH
  if (envPath) {
    if (!deps.exists(envPath)) {
      throw new UexError(`UNIVERSE_EDITOR_PATH does not exist: ${envPath}`, [
        'point it at the editor executable, or unset it to use auto-detection',
      ])
    }
    return { exePath: envPath, source: 'env' }
  }

  if (deps.platform === 'win32') {
    // The installer adds `$INSTDIR\bin` to the user PATH; bin\ue.cmd forwards
    // to `..\Universe Editor.exe` relative to itself.
    const ueCmd = deps.which('ue.cmd')
    if (ueCmd) {
      const exe = p.resolve(p.dirname(ueCmd), '..', PRODUCT_EXE)
      const hit = candidate(deps, exe, 'path')
      if (hit) return hit
    }
    const localAppData = deps.env.LOCALAPPDATA
    if (localAppData) {
      const hit = candidate(
        deps,
        p.join(localAppData, 'Programs', 'Universe Editor', PRODUCT_EXE),
        'install-dir',
      )
      if (hit) return hit
    }
    const installLocation = deps.regInstallLocation()
    if (installLocation) {
      const hit = candidate(deps, p.join(installLocation, PRODUCT_EXE), 'registry')
      if (hit) return hit
    }
    return null
  }

  if (deps.platform === 'darwin') {
    const hit = candidate(
      deps,
      p.join('/Applications', PRODUCT_APP, 'Contents', 'MacOS', 'Universe Editor'),
      'app-bundle',
    )
    if (hit) return hit
    const ue = deps.which('ue')
    return candidate(deps, ue, 'path')
  }

  return (
    candidate(deps, deps.which('universe-editor'), 'path') ??
    candidate(deps, deps.which('ue'), 'path')
  )
}

/** Real deps for the current process. Kept separate so tests never touch the
 *  registry or PATH. */
export function defaultEditorLocatorDeps(platform: NodeJS.Platform): EditorLocatorDeps {
  const which = (cmd: string): string | null => {
    try {
      const tool = platform === 'win32' ? 'where' : 'which'
      const output = execFileSync(tool, [cmd], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const first = output.split(/\r?\n/)[0]?.trim()
      return first ? first : null
    } catch {
      return null
    }
  }
  const regInstallLocation = (): string | null => {
    try {
      const output = execFileSync(
        'reg',
        [
          'query',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
          '/s',
          '/f',
          'Universe Editor',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      )
      return parseRegUninstallInstallLocation(output)
    } catch {
      return null
    }
  }
  return {
    platform: platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux',
    env: process.env,
    exists: existsSync,
    which,
    regInstallLocation,
  }
}
