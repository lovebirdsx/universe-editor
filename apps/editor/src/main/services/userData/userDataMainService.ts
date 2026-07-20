/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process implementation of IUserDataFilesService.
 *
 *  - settings.json / keybindings.json live next to state.json in app.getPath('userData')
 *  - project settings live at <workspace>/.universe-editor/settings.json
 *  - We watch the *parent directory* (not the file directly) so a save-rename
 *    sequence from editors doesn't disconnect the watcher.
 *  - write()/setValue() suppress the watcher's own rename event, then fire an
 *    explicit { source: 'self' } change so open editors reload while config-layer
 *    subscribers (which already hold the value) skip a redundant re-read.
 *  - Writes are atomic (temp file + rename) so readers never see partial JSON.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron'
import { promises as fs, type FSWatcher, watch } from 'node:fs'
import { dirname, join, resolve as resolvePath, basename } from 'node:path'
import os from 'node:os'
import { applyEdits, modify, type FormattingOptions } from 'jsonc-parser'
import {
  Disposable,
  Emitter,
  type Event,
  type IUserDataFileChange,
  type IUserDataFilesService,
  URI,
  UserDataFile,
} from '@universe-editor/platform'
import type { WorkspaceMainService } from '../workspace/workspaceMainService.js'

const SETTINGS_TEMPLATE = `// User settings — edit and save to apply immediately.
// Available keys are declared by ConfigurationRegistry.
{}
`

const KEYBINDINGS_TEMPLATE = `// User keybinding overrides — edit and save to apply immediately.
// Format: [{ "key": "ctrl+shift+b", "command": "workbench.action.foo", "when": "..." }]
// Prefix command with "-" to disable a default binding, e.g. "-workbench.action.foo".
[]
`

const PROJECT_SETTINGS_TEMPLATE = `// Project settings — overrides user settings while this folder is open.
{}
`

const SELF_WRITE_SUPPRESS_MS = 250
const FLUSH_DEBOUNCE_MS = 50

// Cloud-sync folders (OneDrive, 坚果云, …) briefly lock a file right after it's
// written while they index/upload it. A relocate that copies into such a folder
// and immediately reads back races that lock, surfacing EBUSY/EPERM/EACCES.
// These are transient — retry with a short backoff instead of failing the call.
const TRANSIENT_FS_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])

async function retryTransient<T>(op: () => Promise<T>, attempts = 5, baseDelayMs = 60): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await op()
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (!code || !TRANSIENT_FS_CODES.has(code)) throw err
      lastErr = err
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (i + 1)))
      }
    }
  }
  throw lastErr
}

function vscodeUserDir(): string {
  if (process.platform === 'win32') {
    const appdata = process.env['APPDATA'] ?? join(os.homedir(), 'AppData', 'Roaming')
    return join(appdata, 'Code', 'User')
  }
  if (process.platform === 'darwin') {
    return join(os.homedir(), 'Library', 'Application Support', 'Code', 'User')
  }
  const xdgConfig = process.env['XDG_CONFIG_HOME'] ?? join(os.homedir(), '.config')
  return join(xdgConfig, 'Code', 'User')
}

function defaultVSCodeKeybindingsPath(): string {
  // Test hook: let E2E specs point the read-only VSCode keybindings layer at a
  // tmp file instead of the real `%APPDATA%/Code/User/keybindings.json`, so they
  // can exercise VSCode-compat keybinding resolution without touching the host's
  // actual VSCode config. Consistent with this function's other direct env reads.
  const override = process.env['UNIVERSE_VSCODE_KEYBINDINGS_PATH']
  if (override) return override
  return join(vscodeUserDir(), 'keybindings.json')
}

function defaultVSCodeUserSettingsPath(): string {
  // Test hook mirroring UNIVERSE_VSCODE_KEYBINDINGS_PATH: point the read-only
  // VSCode user-settings layer at a tmp file instead of the real
  // `%APPDATA%/Code/User/settings.json`.
  const override = process.env['UNIVERSE_VSCODE_SETTINGS_PATH']
  if (override) return override
  return join(vscodeUserDir(), 'settings.json')
}

const FORMATTING: FormattingOptions = {
  insertSpaces: true,
  tabSize: 2,
  eol: '\n',
}

interface WatchSlot {
  dir: string
  filename: string
  fullPath: string
  readOnly: boolean
  createParentDirForWatcher: boolean
  watcher: FSWatcher | null
  watcherStarting: boolean
  pendingFlush: NodeJS.Timeout | null
  suppressUntil: number
}

interface InstallSlotOptions {
  readonly readOnly?: boolean
  readonly createParentDirForWatcher?: boolean
}

export class UserDataMainService extends Disposable implements IUserDataFilesService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChangeFile = this._register(new Emitter<IUserDataFileChange>())
  readonly onDidChangeFile: Event<IUserDataFileChange> = this._onDidChangeFile.event

  private readonly _slots = new Map<UserDataFile, WatchSlot>()

  constructor(
    private readonly _workspace: WorkspaceMainService,
    configDir?: string,
  ) {
    super()

    // User-level files (settings/keybindings) live in configDir, which defaults
    // to userData but can be relocated (see EnvironmentMainService.configDir).
    const userData = app.getPath('userData')
    const userFilesDir = configDir && configDir.length > 0 ? configDir : userData
    this._installSlot(UserDataFile.Settings, join(userFilesDir, 'settings.json'))
    this._installSlot(UserDataFile.Keybindings, join(userFilesDir, 'keybindings.json'))
    this._installSlot(UserDataFile.AiSettings, join(userFilesDir, 'aiSettings.json'))
    // update-config.json is pinned to userData (deployment config for the update
    // feed) and does not follow a relocated config directory — hence `userData`,
    // not `userFilesDir`, and it stays out of relocate().
    this._installSlot(UserDataFile.UpdateConfig, join(userData, 'update-config.json'))
    this._installSlot(UserDataFile.VSCodeUserSettings, defaultVSCodeUserSettingsPath(), {
      readOnly: true,
    })
    this._installSlot(UserDataFile.VSCodeKeybindings, defaultVSCodeKeybindingsPath(), {
      readOnly: true,
    })

    // Project settings track the active workspace. The read-only VSCode layer
    // (.vscode/settings.json) tracks it in parallel for cross-editor compat.
    this._register(
      this._workspace.onDidChangeWorkspace((ws) => {
        this._teardownSlot(UserDataFile.ProjectSettings)
        this._teardownSlot(UserDataFile.VSCodeSettings)
        if (ws) {
          const projectPath = join(ws.folder.fsPath, '.universe-editor', 'settings.json')
          this._installSlot(UserDataFile.ProjectSettings, projectPath, {
            createParentDirForWatcher: false,
          })
          this._onDidChangeFile.fire({ file: UserDataFile.ProjectSettings, source: 'external' })
          const vscodePath = join(ws.folder.fsPath, '.vscode', 'settings.json')
          this._installSlot(UserDataFile.VSCodeSettings, vscodePath, { readOnly: true })
          this._onDidChangeFile.fire({ file: UserDataFile.VSCodeSettings, source: 'external' })
        } else {
          // Workspace closed — let subscribers reset their workspace layers.
          this._onDidChangeFile.fire({ file: UserDataFile.ProjectSettings, source: 'external' })
          this._onDidChangeFile.fire({ file: UserDataFile.VSCodeSettings, source: 'external' })
        }
      }),
    )
    // Initial hydration: subscribe via getCurrent() so first-launch with a
    // restored workspace also installs the project slots.
    void this._workspace.getCurrent().then((ws) => {
      if (ws && !this._slots.has(UserDataFile.ProjectSettings)) {
        const projectPath = join(ws.folder.fsPath, '.universe-editor', 'settings.json')
        this._installSlot(UserDataFile.ProjectSettings, projectPath, {
          createParentDirForWatcher: false,
        })
      }
      if (ws && !this._slots.has(UserDataFile.VSCodeSettings)) {
        const vscodePath = join(ws.folder.fsPath, '.vscode', 'settings.json')
        this._installSlot(UserDataFile.VSCodeSettings, vscodePath, { readOnly: true })
      }
    })
  }

  override dispose(): void {
    for (const file of [...this._slots.keys()]) {
      this._teardownSlot(file)
    }
    super.dispose()
  }

  async read(file: UserDataFile): Promise<string> {
    const slot = this._slots.get(file)
    if (!slot) return ''
    try {
      return await retryTransient(() => fs.readFile(slot.fullPath, 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw err
    }
  }

  async write(file: UserDataFile, content: string): Promise<void> {
    if (
      file === UserDataFile.VSCodeSettings ||
      file === UserDataFile.VSCodeUserSettings ||
      file === UserDataFile.VSCodeKeybindings
    ) {
      throw new Error(`UserData: ${file} is read-only`)
    }
    const slot = this._slots.get(file)
    if (!slot) {
      throw new Error(`UserData: no workspace open (cannot write ${file})`)
    }
    await this._atomicWrite(file, slot, content)
  }

  async setValue(
    file: UserDataFile,
    jsonPath: readonly (string | number)[],
    value: unknown,
  ): Promise<boolean> {
    if (
      file === UserDataFile.VSCodeSettings ||
      file === UserDataFile.VSCodeUserSettings ||
      file === UserDataFile.VSCodeKeybindings
    )
      return false
    const slot = this._slots.get(file)
    if (!slot) return false
    let current = await this.read(file)
    if (current === '') {
      current = file === UserDataFile.Keybindings ? '[]\n' : '{}\n'
    }
    const edits = modify(current, jsonPath as (string | number)[], value, {
      formattingOptions: FORMATTING,
    })
    const next = applyEdits(current, edits)
    if (next === current) return true
    await this._atomicWrite(file, slot, next)
    return true
  }

  async getFileUri(file: UserDataFile): Promise<URI | null> {
    const slot = this._slots.get(file)
    if (!slot) return null
    return URI.file(slot.fullPath)
  }

  /**
   * Point the user-level slots (settings/keybindings/aiSettings) at a new
   * directory and fire change events so the renderer hot-reloads.
   * Workspace-tracked slots are untouched. No-op when the directory is
   * unchanged.
   */
  relocate(configDir: string): void {
    const userData = app.getPath('userData')
    const dir = configDir && configDir.length > 0 ? configDir : userData
    const settings = this._slots.get(UserDataFile.Settings)
    if (settings && dirname(settings.fullPath) === resolvePath(dir)) return
    this._teardownSlot(UserDataFile.Settings)
    this._teardownSlot(UserDataFile.Keybindings)
    this._teardownSlot(UserDataFile.AiSettings)
    this._installSlot(UserDataFile.Settings, join(dir, 'settings.json'))
    this._installSlot(UserDataFile.Keybindings, join(dir, 'keybindings.json'))
    this._installSlot(UserDataFile.AiSettings, join(dir, 'aiSettings.json'))
    this._onDidChangeFile.fire({ file: UserDataFile.Settings, source: 'external' })
    this._onDidChangeFile.fire({ file: UserDataFile.Keybindings, source: 'external' })
    this._onDidChangeFile.fire({ file: UserDataFile.AiSettings, source: 'external' })
  }

  private _installSlot(
    file: UserDataFile,
    fullPath: string,
    options: InstallSlotOptions = {},
  ): void {
    const absolute = resolvePath(fullPath)
    const dir = dirname(absolute)
    const filename = basename(absolute)
    const readOnly = options.readOnly ?? false
    const slot: WatchSlot = {
      dir,
      filename,
      fullPath: absolute,
      readOnly,
      createParentDirForWatcher: options.createParentDirForWatcher ?? !readOnly,
      watcher: null,
      watcherStarting: false,
      pendingFlush: null,
      suppressUntil: 0,
    }
    this._slots.set(file, slot)
    this._startWatcher(file, slot)
  }

  private _startWatcher(file: UserDataFile, slot: WatchSlot): void {
    if (slot.watcher || slot.watcherStarting) return
    slot.watcherStarting = true
    // Watch the parent dir. fs.watch on a single file disconnects on rename
    // (which is how most editors save), so we always watch one level up.
    // ProjectSettings and read-only VSCode files must not materialize their
    // parent dirs just to install a watcher.
    const ensureDir = slot.createParentDirForWatcher
      ? fs.mkdir(slot.dir, { recursive: true }).then(() => undefined)
      : fs.stat(slot.dir).then((s) => {
          if (!s.isDirectory()) throw new Error('not a directory')
        })
    void ensureDir.then(
      () => {
        slot.watcherStarting = false
        if (this._slots.get(file) !== slot) return
        try {
          slot.watcher = watch(slot.dir, { recursive: false }, (_event, eventFilename) => {
            if (eventFilename === null) return
            const name = typeof eventFilename === 'string' ? eventFilename : String(eventFilename)
            if (name !== slot.filename) return
            if (Date.now() < slot.suppressUntil) return
            if (slot.pendingFlush) return
            slot.pendingFlush = setTimeout(() => {
              slot.pendingFlush = null
              if (Date.now() < slot.suppressUntil) return
              this._onDidChangeFile.fire({ file, source: 'external' })
            }, FLUSH_DEBOUNCE_MS)
          })
          slot.watcher.on('error', () => {
            // Silently stop — caller can retrigger by re-opening the app.
            if (slot.watcher) {
              try {
                slot.watcher.close()
              } catch {
                // ignore
              }
              slot.watcher = null
            }
          })
        } catch {
          // Directory could not be watched — skip silently. The file is still
          // readable/writable; users just won't get hot-reload until restart.
        }
      },
      () => {
        slot.watcherStarting = false
        // Directory unavailable (mkdir failed, or read-only dir absent) — skip
        // silently. The file stays readable; a read-only slot whose dir appears
        // later is picked up on the next workspace change.
      },
    )
  }

  private _teardownSlot(file: UserDataFile): void {
    const slot = this._slots.get(file)
    if (!slot) return
    if (slot.pendingFlush) {
      clearTimeout(slot.pendingFlush)
      slot.pendingFlush = null
    }
    if (slot.watcher) {
      try {
        slot.watcher.close()
      } catch {
        // ignore
      }
      slot.watcher = null
    }
    slot.watcherStarting = false
    this._slots.delete(file)
  }

  private async _atomicWrite(file: UserDataFile, slot: WatchSlot, content: string): Promise<void> {
    slot.suppressUntil = Date.now() + SELF_WRITE_SUPPRESS_MS
    await fs.mkdir(slot.dir, { recursive: true })
    const tmp = `${slot.fullPath}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tmp, content, 'utf8')
    try {
      await retryTransient(() => fs.rename(tmp, slot.fullPath))
    } catch (err) {
      // Best-effort cleanup if rename failed.
      try {
        await fs.unlink(tmp)
      } catch {
        // ignore
      }
      throw err
    }
    // Re-arm so the rename's own fs event is swallowed by the watcher; we fire
    // the self-write change explicitly so open editors reload without the
    // config layer treating it as an external edit to re-read.
    slot.suppressUntil = Date.now() + SELF_WRITE_SUPPRESS_MS
    this._startWatcher(file, slot)
    this._onDidChangeFile.fire({ file, source: 'self' })
  }
}

export { SETTINGS_TEMPLATE, KEYBINDINGS_TEMPLATE, PROJECT_SETTINGS_TEMPLATE }
