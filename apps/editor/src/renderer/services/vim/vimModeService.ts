/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Workbench-wide Vim state. Mode memory is per surface instance (memory only,
 *  as decided), the active-surface snapshot feeds the root context keys and the
 *  status-bar entry, and the effective keymap merges the built-in table with
 *  `vim.keymap` user overrides and the configured leader.
 *
 *  The service owns no DOM listeners: the dispatcher reports mode changes and
 *  the active surface here, and the service writes the observable keys.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  Emitter,
  IConfigurationService,
  IContextKeyService,
  IStatusBarService,
  StatusBarAlignment,
  createDecorator,
  localize,
  type Event,
  type IContextKey,
  type IStatusBarEntry,
  type IStatusBarEntryAccessor,
} from '@universe-editor/platform'
import {
  VIM_DEFAULT_KEYMAP,
  type IVimKeymapEntry,
  type VimSurfaceKind,
  type VimSurfaceMode,
} from '@universe-editor/workbench-ui'

export interface IVimActiveSurface {
  readonly surfaceKey: string
  readonly kind: VimSurfaceKind
  readonly id: string
  readonly defaultMode: VimSurfaceMode
}

export interface IVimModeChangeEvent {
  readonly surfaceKey: string
  readonly mode: VimSurfaceMode
}

export interface IVimModeService {
  readonly _serviceBrand: undefined
  readonly onDidChangeMode: Event<IVimModeChangeEvent>
  getEnabled(): boolean
  getMode(surfaceKey: string, defaultMode: VimSurfaceMode): VimSurfaceMode
  setMode(surfaceKey: string, mode: VimSurfaceMode): void
  /** Drop a surface's remembered mode, e.g. when its editor is closed. */
  forgetSurface(surfaceKey: string): void
  /** Report the surface that owns the keyboard, or undefined when none does. */
  activateSurface(surface: IVimActiveSurface | undefined): void
  readonly activeSurface: IVimActiveSurface | undefined
  getEffectiveKeymap(kind: VimSurfaceKind): readonly IVimKeymapEntry[]
  /** Raw `vim.keymap` overrides, for diagnostics. */
  getUserKeymap(): readonly IVimKeymapEntry[]
  readonly reservedKeys: readonly string[]
  getSequenceTimeoutMs(): number
  getPassThroughUnmappedKeys(): boolean
  getLeader(): string
  getShowStatusBar(): boolean
  isSurfaceEnabled(kind: VimSurfaceKind): boolean
}

export const IVimModeService = createDecorator<IVimModeService>('vimModeService')

const VIM_STATUS_ENTRY_ID = 'vim-mode'
const VIM_STATUS_PRIORITY = 5000
const DEFAULT_LEADER = 'space'
const DEFAULT_SEQUENCE_TIMEOUT_MS = 800
const DEFAULT_RESERVED_KEYS: readonly string[] = [
  'escape',
  'ctrl+[',
  'i',
  'a',
  ':',
  '/',
  '?',
  '<leader>',
]

const CONFIG_KEYS = [
  'vim.enabled',
  'vim.showStatusBar',
  'vim.autoSwitchInputMethod',
  'vim.leader',
  'vim.sequenceTimeoutMs',
  'vim.reservedKeys',
  'vim.passThroughUnmappedKeys',
  'vim.keymap',
  'vim.surfaces.lists',
  'vim.surfaces.tabs',
  'vim.surfaces.activityBar',
  'vim.surfaces.terminalNormalMode',
] as const

function readStringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  // A non-array means "not configured" (fall back); an empty array is a real
  // user choice and must clear the list.
  if (!Array.isArray(value)) return fallback
  const out: string[] = []
  for (const item of value) if (typeof item === 'string') out.push(item)
  return out
}

function normalizeReservedToken(token: string): string {
  return token.length > 1 ? token.toLowerCase() : token
}

function replaceLeader(keys: readonly string[], leader: string): readonly string[] {
  return keys.map((key) => (key === '<leader>' ? leader : key))
}

function parseUserKeymap(value: unknown): readonly IVimKeymapEntry[] {
  if (!Array.isArray(value)) return []
  const entries: IVimKeymapEntry[] = []
  value.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null) return
    const item = raw as Record<string, unknown>
    const keys = item['keys']
    const command = item['command']
    if (!Array.isArray(keys) || typeof command !== 'string') return
    const normalizedKeys: string[] = []
    for (const key of keys) {
      if (typeof key !== 'string' || key.length === 0) return
      normalizedKeys.push(key)
    }
    if (normalizedKeys.length === 0) return
    const id = typeof item['id'] === 'string' ? item['id'] : `user.${index}`
    const surfaces = Array.isArray(item['surfaces'])
      ? (item['surfaces'].filter((s): s is string => typeof s === 'string') as VimSurfaceKind[])
      : undefined
    entries.push({
      id,
      keys: normalizedKeys,
      command,
      ...(item['args'] !== undefined ? { args: item['args'] } : {}),
      ...(typeof item['when'] === 'string' ? { when: item['when'] } : {}),
      ...(surfaces !== undefined ? { surfaces } : {}),
    })
  })
  return entries
}

export class VimModeService extends Disposable implements IVimModeService {
  declare readonly _serviceBrand: undefined

  private readonly _modeBySurface = new Map<string, VimSurfaceMode>()
  private readonly _onDidChangeMode = this._register(new Emitter<IVimModeChangeEvent>())
  readonly onDidChangeMode: Event<IVimModeChangeEvent> = this._onDidChangeMode.event

  private readonly _vimEnabled: IContextKey<boolean>
  private readonly _vimMode: IContextKey<string>
  private readonly _vimNormalMode: IContextKey<boolean>
  private readonly _vimSurface: IContextKey<string>
  private readonly _vimSurfaceId: IContextKey<string>
  private readonly _vimTerminalNormalMode: IContextKey<boolean>

  private _enabled: boolean
  private _showStatusBar = true
  private _leader = DEFAULT_LEADER
  private _sequenceTimeoutMs = DEFAULT_SEQUENCE_TIMEOUT_MS
  private _reservedKeys: readonly string[] = DEFAULT_RESERVED_KEYS
  private _passThroughUnmappedKeys = false
  private _userKeymap: readonly IVimKeymapEntry[] = []
  private _configVersion = 0
  private readonly _keymapCache = new Map<string, readonly IVimKeymapEntry[]>()
  private _surfaceToggles: Record<
    'lists' | 'tabs' | 'activityBar' | 'terminalNormalMode',
    boolean
  > = { lists: true, tabs: true, activityBar: true, terminalNormalMode: true }

  private _activeSurface: IVimActiveSurface | undefined
  private _statusEntry: IStatusBarEntryAccessor | undefined

  constructor(
    @IConfigurationService private readonly _configurationService: IConfigurationService,
    @IContextKeyService contextKeyService: IContextKeyService,
    @IStatusBarService private readonly _statusBarService: IStatusBarService,
  ) {
    super()
    this._vimEnabled = contextKeyService.createKey<boolean>('vimEnabled', false)
    this._vimMode = contextKeyService.createKey<string>('vimMode', '')
    this._vimNormalMode = contextKeyService.createKey<boolean>('vimNormalMode', false)
    this._vimSurface = contextKeyService.createKey<string>('vimSurface', '')
    this._vimSurfaceId = contextKeyService.createKey<string>('vimSurfaceId', '')
    this._vimTerminalNormalMode = contextKeyService.createKey<boolean>(
      'vimTerminalNormalMode',
      false,
    )
    this._enabled = this._configurationService.get<boolean>('vim.enabled') === true
    this.readConfiguration()
    this._vimEnabled.set(this._enabled)
    this._register(
      this._configurationService.onDidChangeConfiguration((event) => {
        for (const key of CONFIG_KEYS) {
          if (!event.affectsConfiguration(key)) continue
          console.debug(`[vim] configuration changed: ${key}`)
          this.readConfiguration()
          this._vimEnabled.set(this._enabled)
          this.applyActiveSurface()
          return
        }
      }),
    )
  }

  get activeSurface(): IVimActiveSurface | undefined {
    return this._activeSurface
  }

  getEnabled(): boolean {
    return this._enabled
  }

  getMode(surfaceKey: string, defaultMode: VimSurfaceMode): VimSurfaceMode {
    return this._modeBySurface.get(surfaceKey) ?? defaultMode
  }

  setMode(surfaceKey: string, mode: VimSurfaceMode): void {
    if (this._modeBySurface.get(surfaceKey) === mode) return
    this._modeBySurface.set(surfaceKey, mode)
    this._onDidChangeMode.fire({ surfaceKey, mode })
    console.debug(`[vim] mode ${surfaceKey} -> ${mode}`)
    if (this._activeSurface?.surfaceKey === surfaceKey) this.applyActiveSurface()
  }

  forgetSurface(surfaceKey: string): void {
    if (!this._modeBySurface.delete(surfaceKey)) return
    console.debug(`[vim] mode forgotten: ${surfaceKey}`)
    if (this._activeSurface?.surfaceKey === surfaceKey) this.applyActiveSurface()
  }

  activateSurface(surface: IVimActiveSurface | undefined): void {
    const same =
      this._activeSurface?.surfaceKey === surface?.surfaceKey &&
      this._activeSurface?.kind === surface?.kind &&
      this._activeSurface?.id === surface?.id
    if (same) return
    const previous = this._activeSurface
    this._activeSurface = surface
    if (previous !== undefined && surface === undefined) {
      console.debug(`[vim] surface inactive: ${previous.surfaceKey}`)
    } else if (surface !== undefined) {
      console.debug(`[vim] surface active: ${surface.kind}/${surface.surfaceKey}`)
    }
    this.applyActiveSurface()
  }

  getEffectiveKeymap(kind: VimSurfaceKind): readonly IVimKeymapEntry[] {
    const cacheKey = `${kind}\u0000${this._leader}\u0000${this._configVersion}`
    const cached = this._keymapCache.get(cacheKey)
    if (cached !== undefined) return cached
    const leader = this._leader
    const overrides = new Map(this._userKeymap.map((entry) => [entry.id, entry]))
    const merged: IVimKeymapEntry[] = []
    for (const entry of VIM_DEFAULT_KEYMAP) {
      const chosen = overrides.get(entry.id) ?? entry
      if (chosen.surfaces !== undefined && !chosen.surfaces.includes(kind)) continue
      merged.push({ ...chosen, keys: replaceLeader(chosen.keys, leader) })
    }
    const defaultIds = new Set(VIM_DEFAULT_KEYMAP.map((entry) => entry.id))
    for (const entry of this._userKeymap) {
      if (defaultIds.has(entry.id)) continue
      if (entry.surfaces !== undefined && !entry.surfaces.includes(kind)) continue
      merged.push({ ...entry, keys: replaceLeader(entry.keys, leader) })
    }
    this._keymapCache.set(cacheKey, merged)
    return merged
  }

  getUserKeymap(): readonly IVimKeymapEntry[] {
    return this._userKeymap
  }

  get reservedKeys(): readonly string[] {
    return this._reservedKeys
  }

  getSequenceTimeoutMs(): number {
    return this._sequenceTimeoutMs
  }

  getPassThroughUnmappedKeys(): boolean {
    return this._passThroughUnmappedKeys
  }

  getLeader(): string {
    return this._leader
  }

  getShowStatusBar(): boolean {
    return this._showStatusBar
  }

  isSurfaceEnabled(kind: VimSurfaceKind): boolean {
    switch (kind) {
      case 'list':
      case 'menu':
      case 'overlay':
        return this._surfaceToggles.lists
      case 'tabs':
        return this._surfaceToggles.tabs
      case 'activityBar':
      case 'viewContainerTabs':
        return this._surfaceToggles.activityBar
      case 'terminal':
        return this._surfaceToggles.terminalNormalMode
      case 'editor':
        return true
      case 'webview':
        return false
    }
  }

  private readConfiguration(): void {
    this._configVersion++
    this._keymapCache.clear()
    const config = this._configurationService
    this._enabled = config.get<boolean>('vim.enabled') === true
    this._showStatusBar = config.get<boolean>('vim.showStatusBar') !== false
    const leader = config.get<string>('vim.leader')
    this._leader = typeof leader === 'string' && leader.length > 0 ? leader : DEFAULT_LEADER
    const timeout = config.get<number>('vim.sequenceTimeoutMs')
    this._sequenceTimeoutMs =
      typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
        ? timeout
        : DEFAULT_SEQUENCE_TIMEOUT_MS
    this._reservedKeys = readStringArray(
      config.get<unknown>('vim.reservedKeys'),
      DEFAULT_RESERVED_KEYS,
    ).map((token) => normalizeReservedToken(replaceLeader([token], this._leader)[0]!))
    this._passThroughUnmappedKeys = config.get<boolean>('vim.passThroughUnmappedKeys') === true
    this._userKeymap = parseUserKeymap(config.get<unknown>('vim.keymap'))
    this._surfaceToggles = {
      lists: config.get<boolean>('vim.surfaces.lists') !== false,
      tabs: config.get<boolean>('vim.surfaces.tabs') !== false,
      activityBar: config.get<boolean>('vim.surfaces.activityBar') !== false,
      terminalNormalMode: config.get<boolean>('vim.surfaces.terminalNormalMode') !== false,
    }
  }

  private applyActiveSurface(): void {
    const surface = this._activeSurface
    if (!this._enabled || surface === undefined) {
      this._vimMode.set('')
      this._vimNormalMode.set(false)
      this._vimSurface.set('')
      this._vimSurfaceId.set('')
      this._vimTerminalNormalMode.set(false)
      this.syncStatusBar()
      return
    }
    const mode = this.getMode(surface.surfaceKey, surface.defaultMode)
    this._vimMode.set(mode === 'insert' ? 'insert' : 'normal')
    this._vimNormalMode.set(mode === 'normal')
    this._vimSurface.set(surface.kind)
    this._vimSurfaceId.set(surface.id)
    this._vimTerminalNormalMode.set(mode === 'terminal-normal')
    this.syncStatusBar()
  }

  private statusEntry(mode: VimSurfaceMode): IStatusBarEntry {
    return {
      id: VIM_STATUS_ENTRY_ID,
      text: '',
      icon: mode === 'insert' ? 'vim-insert' : 'vim-normal',
      tooltip:
        mode === 'insert'
          ? localize('vim.status.insert', 'Vim: Insert (click to toggle)')
          : localize('vim.status.normal', 'Vim: Normal (click to toggle)'),
      alignment: StatusBarAlignment.Right,
      priority: VIM_STATUS_PRIORITY,
      command: 'workbench.action.toggleVimMode',
    }
  }

  private syncStatusBar(): void {
    const surface = this._activeSurface
    if (!this._enabled || !this._showStatusBar || surface === undefined) {
      this._statusEntry?.dispose()
      this._statusEntry = undefined
      return
    }
    const entry = this.statusEntry(this.getMode(surface.surfaceKey, surface.defaultMode))
    if (this._statusEntry === undefined) {
      this._statusEntry = this._statusBarService.addEntry(entry)
      return
    }
    this._statusEntry.update(entry)
  }

  override dispose(): void {
    this._statusEntry?.dispose()
    this._statusEntry = undefined
    super.dispose()
  }
}
