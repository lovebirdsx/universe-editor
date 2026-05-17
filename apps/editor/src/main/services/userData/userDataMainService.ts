/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process implementation of IUserDataFilesService.
 *
 *  - settings.json / keybindings.json live next to state.json in app.getPath('userData')
 *  - project settings live at <workspace>/.universe-editor/settings.json
 *  - We watch the *parent directory* (not the file directly) so a save-rename
 *    sequence from editors doesn't disconnect the watcher.
 *  - write()/setValue() are followed by a ~200ms self-write window during which
 *    inbound fs events for that file are dropped — keeps the round trip quiet.
 *  - Writes are atomic (temp file + rename) so readers never see partial JSON.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron'
import { promises as fs, type FSWatcher, watch } from 'node:fs'
import { dirname, join, resolve as resolvePath, basename } from 'node:path'
import { applyEdits, modify, type FormattingOptions } from 'jsonc-parser'
import {
  Disposable,
  Emitter,
  type Event,
  type IUserDataFilesService,
  URI,
  UserDataFile,
  type UriComponents,
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

const FORMATTING: FormattingOptions = {
  insertSpaces: true,
  tabSize: 2,
  eol: '\n',
}

interface WatchSlot {
  dir: string
  filename: string
  fullPath: string
  watcher: FSWatcher | null
  pendingFlush: NodeJS.Timeout | null
  suppressUntil: number
}

export class UserDataMainService extends Disposable implements IUserDataFilesService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChangeFile = this._register(new Emitter<UserDataFile>())
  readonly onDidChangeFile: Event<UserDataFile> = this._onDidChangeFile.event

  private readonly _slots = new Map<UserDataFile, WatchSlot>()

  constructor(private readonly _workspace: WorkspaceMainService) {
    super()

    const userData = app.getPath('userData')
    this._installSlot(UserDataFile.Settings, join(userData, 'settings.json'))
    this._installSlot(UserDataFile.Keybindings, join(userData, 'keybindings.json'))

    // Project settings track the active workspace.
    this._register(
      this._workspace.onDidChangeWorkspace((ws) => {
        this._teardownSlot(UserDataFile.ProjectSettings)
        if (ws) {
          const projectPath = join(ws.folder.fsPath, '.universe-editor', 'settings.json')
          this._installSlot(UserDataFile.ProjectSettings, projectPath)
          this._onDidChangeFile.fire(UserDataFile.ProjectSettings)
        } else {
          // Workspace closed — let subscribers reset their Project layer.
          this._onDidChangeFile.fire(UserDataFile.ProjectSettings)
        }
      }),
    )
    // Initial hydration: subscribe via getCurrent() so first-launch with a
    // restored workspace also installs the project slot.
    void this._workspace.getCurrent().then((ws) => {
      if (ws && !this._slots.has(UserDataFile.ProjectSettings)) {
        const projectPath = join(ws.folder.fsPath, '.universe-editor', 'settings.json')
        this._installSlot(UserDataFile.ProjectSettings, projectPath)
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
      return await fs.readFile(slot.fullPath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw err
    }
  }

  async write(file: UserDataFile, content: string): Promise<void> {
    const slot = this._slots.get(file)
    if (!slot) {
      throw new Error(`UserData: no workspace open (cannot write ${file})`)
    }
    await this._atomicWrite(slot, content)
  }

  async setValue(
    file: UserDataFile,
    jsonPath: readonly (string | number)[],
    value: unknown,
  ): Promise<boolean> {
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
    await this._atomicWrite(slot, next)
    return true
  }

  async getFileUri(file: UserDataFile): Promise<UriComponents | null> {
    const slot = this._slots.get(file)
    if (!slot) return null
    return URI.file(slot.fullPath).toJSON()
  }

  private _installSlot(file: UserDataFile, fullPath: string): void {
    const absolute = resolvePath(fullPath)
    const dir = dirname(absolute)
    const filename = basename(absolute)
    const slot: WatchSlot = {
      dir,
      filename,
      fullPath: absolute,
      watcher: null,
      pendingFlush: null,
      suppressUntil: 0,
    }
    this._slots.set(file, slot)
    this._startWatcher(file, slot)
  }

  private _startWatcher(file: UserDataFile, slot: WatchSlot): void {
    // Watch the parent dir. fs.watch on a single file disconnects on rename
    // (which is how most editors save), so we always watch one level up.
    void fs.mkdir(slot.dir, { recursive: true }).then(
      () => {
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
              this._onDidChangeFile.fire(file)
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
        // mkdir failed — skip silently for the same reason.
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
    this._slots.delete(file)
  }

  private async _atomicWrite(slot: WatchSlot, content: string): Promise<void> {
    slot.suppressUntil = Date.now() + SELF_WRITE_SUPPRESS_MS
    await fs.mkdir(slot.dir, { recursive: true })
    const tmp = `${slot.fullPath}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tmp, content, 'utf8')
    try {
      await fs.rename(tmp, slot.fullPath)
    } catch (err) {
      // Best-effort cleanup if rename failed.
      try {
        await fs.unlink(tmp)
      } catch {
        // ignore
      }
      throw err
    }
    // Re-arm: the rename itself fires events.
    slot.suppressUntil = Date.now() + SELF_WRITE_SUPPRESS_MS
  }
}

export { SETTINGS_TEMPLATE, KEYBINDINGS_TEMPLATE, PROJECT_SETTINGS_TEMPLATE }
