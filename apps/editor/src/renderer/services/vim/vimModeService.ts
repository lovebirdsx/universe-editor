/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Workbench-wide Vim state. Mode memory is per surface instance (memory only,
 *  as decided), the active-surface snapshot feeds the root context keys and the
 *  status-bar entry, and the effective keymap merges the generic table, the app
 *  table, the active surface's own keys and `vim.keymap` user entries (see
 *  `vimKeymapMerge.ts`) under the configured leader. This service is the only
 *  writer of the `vim*` context keys.
 *
 *  It also owns the transient feedback shown while typing: the mode label
 *  (`NORMAL` / `VISUAL` / ...), pending keys, the brief `Unsupported: <key>` notice
 *  and the which-key state the overlay renders.
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
  describeInvalidVimToken,
  type IVimKeymapEntry,
  type VimSurfaceKind,
  type VimSurfaceMode,
} from '@universe-editor/workbench-ui'
import { VIM_APP_KEYMAP } from './vimAppKeymap.js'
import { VIM_SURFACE_KEYMAPS } from './vimSurfaceKeymaps.js'
import {
  mergeVimKeymap,
  parseUserKeymap,
  replaceLeader,
  type IVimUserKeymapItem,
} from './vimKeymapMerge.js'

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

/**
 * The editor core's finer mode. The service stores it next to the coarse
 * `VimSurfaceMode`: every visual flavour is a `normal` mode as far as context keys
 * (`vimNormalMode`) and the dispatcher are concerned, and only the status bar and
 * `vimVisualMode` tell them apart.
 */
export type VimEditorMode = 'normal' | 'insert' | 'visual' | 'visual-line' | 'visual-block'

export interface IVimWhichKeyItem {
  /** Next key, already formatted for display (`e`, `<C-d>`). */
  readonly key: string
  /** Command title, or a `+N` label for a key that only opens a longer sequence. */
  readonly title: string
  /** True when the key only opens a longer sequence. */
  readonly isGroup: boolean
}

export interface IVimWhichKeyState {
  /** Sequence typed so far, formatted (`<Space>`, `<Space>w`). */
  readonly prefix: string
  readonly items: readonly IVimWhichKeyItem[]
}

export interface IVimModeService {
  readonly _serviceBrand: undefined
  readonly onDidChangeMode: Event<IVimModeChangeEvent>
  /** Fires when the surface that owns the keyboard changes (including to none). */
  readonly onDidChangeActiveSurface: Event<IVimActiveSurface | undefined>
  getEnabled(): boolean
  getMode(surfaceKey: string, defaultMode: VimSurfaceMode): VimSurfaceMode
  setMode(surfaceKey: string, mode: VimSurfaceMode): void
  /** Drop a surface's remembered mode, e.g. when its editor is closed. */
  forgetSurface(surfaceKey: string): void
  /** Report the surface that owns the keyboard, or undefined when none does. */
  activateSurface(surface: IVimActiveSurface | undefined): void
  readonly activeSurface: IVimActiveSurface | undefined
  /**
   * Keymap for a surface of `kind`. `surfaceKeymap` is what that surface
   * declared itself (`IActiveVimSurface.keymap`); it is merged in, tried first,
   * and the result is cached per array identity.
   */
  getEffectiveKeymap(
    kind: VimSurfaceKind,
    surfaceKeymap?: readonly IVimKeymapEntry[],
  ): readonly IVimKeymapEntry[]
  /** Parsed `vim.keymap` items (overrides, additions, unbinds), for diagnostics. */
  getUserKeymap(): readonly IVimUserKeymapItem[]
  /** Problems found while parsing `vim.keymap`; each is also logged once. */
  getUserKeymapIssues(): readonly string[]
  readonly reservedKeys: readonly string[]
  getSequenceTimeoutMs(): number
  getPassThroughUnmappedKeys(): boolean
  getLeader(): string
  getShowStatusBar(): boolean
  isSurfaceEnabled(kind: VimSurfaceKind): boolean

  /** Editor core's pending sequence (counts, operators, `g` prefixes); `''` clears it. */
  setPendingKeys(keys: string): void
  /** The workbench sequence engine's pending count + prefix, reported by the dispatcher. */
  setSequencePendingKeys(keys: string): void
  /** What the status bar shows next to the mode: the editor core's keys win over the engine's. */
  readonly pendingKeys: string
  /**
   * Briefly show `Unsupported: <key>` in the status bar (throttled, no notification).
   * `key` is display-ready text and is shown verbatim, never re-formatted: callers
   * holding Vim tokens format them first (`formatVimKeys(['space', 'x'])` →
   * `<Space>x`); the editor core passes its raw key name (`q`, `F2`).
   */
  reportUnsupportedKey(key: string): void
  /** The key currently shown as unsupported-key feedback, or undefined. */
  readonly unsupportedKey: string | undefined
  /**
   * Fine-grained mode of the active editor surface. A visual flavour counts as
   * `normal` for `setMode` / `vimNormalMode` and additionally sets `vimVisualMode`.
   * Ignored while the active surface is not an editor.
   */
  setEditorSubMode(mode: VimEditorMode): void
  getEditorSubMode(surfaceKey: string): VimEditorMode

  getWhichKeyEnabled(): boolean
  readonly whichKey: IVimWhichKeyState | undefined
  readonly onDidChangeWhichKey: Event<IVimWhichKeyState | undefined>
  setWhichKey(state: IVimWhichKeyState | undefined): void
}

export const IVimModeService = createDecorator<IVimModeService>('vimModeService')

const VIM_STATUS_ENTRY_ID = 'vim-mode'
const VIM_STATUS_PRIORITY = 5000
const VIM_FEEDBACK_ENTRY_ID = 'vim-feedback'
const UNSUPPORTED_DISPLAY_MS = 1500
const UNSUPPORTED_THROTTLE_MS = 100
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

const EDITOR_MODE_LABELS: Readonly<Record<VimEditorMode, string>> = {
  normal: 'NORMAL',
  insert: 'INSERT',
  visual: 'VISUAL',
  'visual-line': 'V-LINE',
  'visual-block': 'V-BLOCK',
}

/**
 * Every `vim.*` key this service reacts to. Listed by hand because
 * `affectsConfiguration` is an exact match; a unit test asserts it covers what
 * `SettingsContribution` registers (minus the editor-controller-only keys).
 */
export const VIM_SERVICE_CONFIG_KEYS = [
  'vim.enabled',
  'vim.showStatusBar',
  'vim.autoSwitchInputMethod',
  'vim.leader',
  'vim.sequenceTimeoutMs',
  'vim.reservedKeys',
  'vim.passThroughUnmappedKeys',
  'vim.whichKey',
  'vim.keymap',
  'vim.surfaces.lists',
  'vim.surfaces.menus',
  'vim.surfaces.overlays',
  'vim.surfaces.tabs',
  'vim.surfaces.activityBar',
  'vim.surfaces.terminalNormalMode',
  'vim.surfaces.editor',
] as const

type SurfaceToggleName =
  | 'lists'
  | 'menus'
  | 'overlays'
  | 'tabs'
  | 'activityBar'
  | 'terminalNormalMode'
  | 'editor'

const SURFACE_TOGGLE_NAMES: readonly SurfaceToggleName[] = [
  'lists',
  'menus',
  'overlays',
  'tabs',
  'activityBar',
  'terminalNormalMode',
  'editor',
]

/** Which `vim.surfaces.*` switch governs each surface kind. */
const TOGGLE_BY_KIND: Readonly<Record<VimSurfaceKind, SurfaceToggleName | undefined>> = {
  list: 'lists',
  reader: 'lists',
  menu: 'menus',
  overlay: 'overlays',
  tabs: 'tabs',
  activityBar: 'activityBar',
  viewContainerTabs: 'activityBar',
  terminal: 'terminalNormalMode',
  editor: 'editor',
  // The dispatcher stays out of webviews; the kind exists only to mark the DOM.
  webview: undefined,
}

/** Entries `vim.keymap` may override, unbind or extend by id. */
const BUILT_IN_ENTRIES: readonly IVimKeymapEntry[] = [
  ...VIM_DEFAULT_KEYMAP,
  ...VIM_APP_KEYMAP,
  ...VIM_SURFACE_KEYMAPS,
]
const BASE_ENTRIES: readonly IVimKeymapEntry[] = [...VIM_DEFAULT_KEYMAP, ...VIM_APP_KEYMAP]

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

/**
 * `vim.leader` is typed by hand: `Space`, `<space>` and `<Space>` all mean the
 * `space` token. Returns undefined when the value can never match a keystroke.
 */
export function normalizeLeader(raw: string): string | undefined {
  if (raw === ' ') return DEFAULT_LEADER
  let token = raw.trim()
  const bracketed = /^<(.+)>$/.exec(token)
  if (bracketed !== null) token = bracketed[1]!
  if (token.length === 0) return undefined
  if (token.length > 1) token = token.toLowerCase()
  if (token === '<leader>' || describeInvalidVimToken(token) !== undefined) return undefined
  return token
}

export class VimModeService extends Disposable implements IVimModeService {
  declare readonly _serviceBrand: undefined

  private readonly _modeBySurface = new Map<string, VimSurfaceMode>()
  private readonly _subModeBySurface = new Map<string, VimEditorMode>()
  private readonly _onDidChangeMode = this._register(new Emitter<IVimModeChangeEvent>())
  readonly onDidChangeMode: Event<IVimModeChangeEvent> = this._onDidChangeMode.event
  private readonly _onDidChangeActiveSurface = this._register(
    new Emitter<IVimActiveSurface | undefined>(),
  )
  readonly onDidChangeActiveSurface: Event<IVimActiveSurface | undefined> =
    this._onDidChangeActiveSurface.event
  private readonly _onDidChangeWhichKey = this._register(
    new Emitter<IVimWhichKeyState | undefined>(),
  )
  readonly onDidChangeWhichKey: Event<IVimWhichKeyState | undefined> =
    this._onDidChangeWhichKey.event

  private readonly _vimEnabled: IContextKey<boolean>
  private readonly _vimMode: IContextKey<string>
  private readonly _vimNormalMode: IContextKey<boolean>
  private readonly _vimVisualMode: IContextKey<boolean>
  private readonly _vimSurface: IContextKey<string>
  private readonly _vimSurfaceId: IContextKey<string>
  private readonly _vimTerminalNormalMode: IContextKey<boolean>

  private _enabled: boolean
  private _showStatusBar = true
  private _leader = DEFAULT_LEADER
  private _sequenceTimeoutMs = DEFAULT_SEQUENCE_TIMEOUT_MS
  private _reservedKeys: readonly string[] = DEFAULT_RESERVED_KEYS
  private _passThroughUnmappedKeys = false
  private _whichKeyEnabled = true
  private _userKeymap: readonly IVimUserKeymapItem[] = []
  private _userKeymapIssues: readonly string[] = []
  private readonly _warnedIssues = new Set<string>()
  private _configVersion = 0
  private readonly _keymapCache = new Map<string, readonly IVimKeymapEntry[]>()
  private readonly _surfaceKeymapCache = new WeakMap<
    readonly IVimKeymapEntry[],
    { readonly key: string; readonly merged: readonly IVimKeymapEntry[] }
  >()
  private _surfaceToggles: Record<SurfaceToggleName, boolean> = {
    lists: true,
    menus: true,
    overlays: true,
    tabs: true,
    activityBar: true,
    terminalNormalMode: true,
    editor: true,
  }

  private _whichKey: IVimWhichKeyState | undefined
  private _editorPending = ''
  private _enginePending = ''
  private _unsupported: string | undefined
  private _unsupportedTimer: ReturnType<typeof setTimeout> | undefined
  private _unsupportedRefreshedAt = 0

  private _activeSurface: IVimActiveSurface | undefined
  private _statusEntry: IStatusBarEntryAccessor | undefined
  private _feedbackEntry: IStatusBarEntryAccessor | undefined

  constructor(
    @IConfigurationService private readonly _configurationService: IConfigurationService,
    @IContextKeyService contextKeyService: IContextKeyService,
    @IStatusBarService private readonly _statusBarService: IStatusBarService,
  ) {
    super()
    this._vimEnabled = contextKeyService.createKey<boolean>('vimEnabled', false)
    this._vimMode = contextKeyService.createKey<string>('vimMode', '')
    this._vimNormalMode = contextKeyService.createKey<boolean>('vimNormalMode', false)
    this._vimVisualMode = contextKeyService.createKey<boolean>('vimVisualMode', false)
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
        for (const key of VIM_SERVICE_CONFIG_KEYS) {
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
    if (this.writeMode(surfaceKey, mode)) this.refreshIfActive(surfaceKey)
  }

  /** Stores the coarse mode; a change also drops a stale visual sub-mode. */
  private writeMode(surfaceKey: string, mode: VimSurfaceMode): boolean {
    if (this._modeBySurface.get(surfaceKey) === mode) return false
    this._modeBySurface.set(surfaceKey, mode)
    this._subModeBySurface.delete(surfaceKey)
    this._onDidChangeMode.fire({ surfaceKey, mode })
    console.debug(`[vim] mode ${surfaceKey} -> ${mode}`)
    return true
  }

  private refreshIfActive(surfaceKey: string): void {
    if (this._activeSurface?.surfaceKey === surfaceKey) this.applyActiveSurface()
  }

  forgetSurface(surfaceKey: string): void {
    const hadSub = this._subModeBySurface.delete(surfaceKey)
    if (!this._modeBySurface.delete(surfaceKey) && !hadSub) return
    console.debug(`[vim] mode forgotten: ${surfaceKey}`)
    this.refreshIfActive(surfaceKey)
  }

  setEditorSubMode(mode: VimEditorMode): void {
    const surface = this._activeSurface
    if (surface === undefined || surface.kind !== 'editor') return
    const key = surface.surfaceKey
    const changed = this.writeMode(key, mode === 'insert' ? 'insert' : 'normal')
    const before = this._subModeBySurface.get(key)
    const visual = mode !== 'normal' && mode !== 'insert'
    if (visual) {
      this._subModeBySurface.set(key, mode)
      console.debug(`[vim] sub-mode ${key} -> ${mode}`)
    } else {
      this._subModeBySurface.delete(key)
    }
    if (changed || before !== (visual ? mode : undefined)) this.refreshIfActive(key)
  }

  getEditorSubMode(surfaceKey: string): VimEditorMode {
    const sub = this._subModeBySurface.get(surfaceKey)
    if (sub !== undefined) return sub
    return this._modeBySurface.get(surfaceKey) === 'insert' ? 'insert' : 'normal'
  }

  activateSurface(surface: IVimActiveSurface | undefined): void {
    const same =
      this._activeSurface?.surfaceKey === surface?.surfaceKey &&
      this._activeSurface?.kind === surface?.kind &&
      this._activeSurface?.id === surface?.id
    if (same) return
    const previous = this._activeSurface
    this._activeSurface = surface
    // Pending keys, the unsupported notice and which-key belong to the surface
    // that produced them.
    if (previous?.surfaceKey !== surface?.surfaceKey) this.resetFeedback()
    this._onDidChangeActiveSurface.fire(surface)
    if (previous !== undefined && surface === undefined) {
      console.debug(`[vim] surface inactive: ${previous.surfaceKey}`)
    } else if (surface !== undefined) {
      console.debug(`[vim] surface active: ${surface.kind}/${surface.surfaceKey}`)
    }
    this.applyActiveSurface()
  }

  get pendingKeys(): string {
    return this._editorPending || this._enginePending
  }

  get unsupportedKey(): string | undefined {
    return this._unsupported
  }

  setPendingKeys(keys: string): void {
    if (this._editorPending === keys) return
    this._editorPending = keys
    this.syncFeedback()
  }

  setSequencePendingKeys(keys: string): void {
    if (this._enginePending === keys) return
    this._enginePending = keys
    this.syncFeedback()
  }

  reportUnsupportedKey(key: string): void {
    if (!this._enabled || !this._showStatusBar || key.length === 0) return
    const text = key
    const now = Date.now()
    // Held-down keys repeat ~30 times a second: the same key only restarts the
    // display clock, and not even that more often than the throttle window.
    if (
      this._unsupported === text &&
      now - this._unsupportedRefreshedAt < UNSUPPORTED_THROTTLE_MS
    ) {
      return
    }
    this._unsupportedRefreshedAt = now
    if (this._unsupportedTimer !== undefined) clearTimeout(this._unsupportedTimer)
    this._unsupportedTimer = setTimeout(() => this.clearUnsupported(), UNSUPPORTED_DISPLAY_MS)
    if (this._unsupported === text) return
    this._unsupported = text
    console.debug(`[vim] unsupported key: ${text}`)
    this.syncFeedback()
  }

  private clearUnsupported(): void {
    if (this._unsupportedTimer !== undefined) clearTimeout(this._unsupportedTimer)
    this._unsupportedTimer = undefined
    if (this._unsupported === undefined) return
    this._unsupported = undefined
    this.syncFeedback()
  }

  private resetFeedback(): void {
    this._editorPending = ''
    this._enginePending = ''
    this.clearUnsupported()
    this.setWhichKey(undefined)
    this.syncFeedback()
  }

  getWhichKeyEnabled(): boolean {
    return this._whichKeyEnabled
  }

  get whichKey(): IVimWhichKeyState | undefined {
    return this._whichKey
  }

  setWhichKey(state: IVimWhichKeyState | undefined): void {
    if (this._whichKey === state) return
    this._whichKey = state
    this._onDidChangeWhichKey.fire(state)
  }

  getEffectiveKeymap(
    kind: VimSurfaceKind,
    surfaceKeymap?: readonly IVimKeymapEntry[],
  ): readonly IVimKeymapEntry[] {
    const key = `${kind}\u0000${this._leader}\u0000${this._configVersion}`
    if (surfaceKeymap === undefined || surfaceKeymap.length === 0) {
      const cached = this._keymapCache.get(key)
      if (cached !== undefined) return cached
      const merged = mergeVimKeymap(
        kind,
        BASE_ENTRIES,
        [],
        this._userKeymap,
        this._leader,
        VIM_SURFACE_KEYMAPS,
      )
      this._keymapCache.set(key, merged)
      return merged
    }
    const cached = this._surfaceKeymapCache.get(surfaceKeymap)
    if (cached !== undefined && cached.key === key) return cached.merged
    const merged = mergeVimKeymap(
      kind,
      BASE_ENTRIES,
      surfaceKeymap,
      this._userKeymap,
      this._leader,
      VIM_SURFACE_KEYMAPS,
    )
    this._surfaceKeymapCache.set(surfaceKeymap, { key, merged })
    return merged
  }

  getUserKeymap(): readonly IVimUserKeymapItem[] {
    return this._userKeymap
  }

  getUserKeymapIssues(): readonly string[] {
    return this._userKeymapIssues
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
    const toggle = TOGGLE_BY_KIND[kind]
    return toggle !== undefined && this._surfaceToggles[toggle]
  }

  private readConfiguration(): void {
    this._configVersion++
    this._keymapCache.clear()
    const config = this._configurationService
    this._enabled = config.get<boolean>('vim.enabled') === true
    this._showStatusBar = config.get<boolean>('vim.showStatusBar') !== false
    this._leader = this.readLeader(config.get<unknown>('vim.leader'))
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
    this._whichKeyEnabled = config.get<boolean>('vim.whichKey') !== false
    if (!this._whichKeyEnabled) this.setWhichKey(undefined)
    const parsed = parseUserKeymap(
      config.get<unknown>('vim.keymap'),
      BUILT_IN_ENTRIES,
      this._leader,
    )
    this._userKeymap = parsed.items
    this._userKeymapIssues = parsed.issues
    for (const issue of parsed.issues) this.warnOnce(issue)
    const toggles = {} as Record<SurfaceToggleName, boolean>
    for (const name of SURFACE_TOGGLE_NAMES) {
      toggles[name] = config.get<boolean>(`vim.surfaces.${name}`) !== false
    }
    this._surfaceToggles = toggles
  }

  private readLeader(raw: unknown): string {
    if (raw === undefined || raw === null) return DEFAULT_LEADER
    const leader = typeof raw === 'string' ? normalizeLeader(raw) : undefined
    if (leader !== undefined) return leader
    this.warnOnce(
      `vim.leader ${JSON.stringify(raw)} is not a valid Vim key; using '${DEFAULT_LEADER}'`,
    )
    return DEFAULT_LEADER
  }

  private warnOnce(issue: string): void {
    if (this._warnedIssues.has(issue)) return
    this._warnedIssues.add(issue)
    console.warn(`[vim] ${issue}`)
  }

  private applyActiveSurface(): void {
    const surface = this._activeSurface
    // A surface switched off in settings is as good as absent: its mode must not
    // leak into `vimNormalMode`, which the global paging safety net trusts.
    if (!this._enabled || surface === undefined || !this.isSurfaceEnabled(surface.kind)) {
      this._vimMode.set('')
      this._vimNormalMode.set(false)
      this._vimVisualMode.set(false)
      this._vimSurface.set('')
      this._vimSurfaceId.set('')
      this._vimTerminalNormalMode.set(false)
      this.resetFeedback()
      this.syncStatusBar()
      return
    }
    const mode = this.getMode(surface.surfaceKey, surface.defaultMode)
    this._vimMode.set(mode === 'insert' ? 'insert' : 'normal')
    // Visual flavours are normal-class: the global paging safety net and
    // `vimNormalMode` keybindings must keep treating them as Normal.
    this._vimNormalMode.set(mode === 'normal')
    this._vimVisualMode.set(surface.kind === 'editor' && this.isVisual(surface.surfaceKey))
    this._vimSurface.set(surface.kind)
    this._vimSurfaceId.set(surface.id)
    this._vimTerminalNormalMode.set(mode === 'terminal-normal')
    this.syncStatusBar()
  }

  private isVisual(surfaceKey: string): boolean {
    const sub = this._subModeBySurface.get(surfaceKey)
    return sub !== undefined && sub !== 'normal' && sub !== 'insert'
  }

  private modeLabel(surface: IVimActiveSurface, mode: VimSurfaceMode): string {
    if (mode === 'terminal-normal') return 'TERMINAL'
    if (surface.kind === 'editor') {
      return EDITOR_MODE_LABELS[this.getEditorSubMode(surface.surfaceKey)]
    }
    return mode === 'insert' ? 'INSERT' : 'NORMAL'
  }

  private modeTooltip(surface: IVimActiveSurface, mode: VimSurfaceMode): string {
    if (mode === 'terminal-normal') {
      return localize('vim.status.terminalNormal', 'Vim: Terminal Normal (click to toggle)')
    }
    if (surface.kind === 'editor') {
      switch (this.getEditorSubMode(surface.surfaceKey)) {
        case 'visual':
          return localize('vim.status.visual', 'Vim: Visual (click to toggle)')
        case 'visual-line':
          return localize('vim.status.visualLine', 'Vim: Visual Line (click to toggle)')
        case 'visual-block':
          return localize('vim.status.visualBlock', 'Vim: Visual Block (click to toggle)')
        default:
          break
      }
    }
    return mode === 'insert'
      ? localize('vim.status.insert', 'Vim: Insert (click to toggle)')
      : localize('vim.status.normal', 'Vim: Normal (click to toggle)')
  }

  private statusEntry(surface: IVimActiveSurface, mode: VimSurfaceMode): IStatusBarEntry {
    return {
      id: VIM_STATUS_ENTRY_ID,
      text: this.modeLabel(surface, mode),
      icon: mode === 'insert' ? 'vim-insert' : 'vim-normal',
      tooltip: this.modeTooltip(surface, mode),
      alignment: StatusBarAlignment.Right,
      priority: VIM_STATUS_PRIORITY,
      command: 'workbench.action.toggleVimMode',
    }
  }

  /** Pending keys and the unsupported-key notice share one entry next to the mode. */
  private syncFeedback(): void {
    const text =
      this._unsupported !== undefined
        ? localize('vim.status.unsupported', 'Unsupported: {key}', { key: this._unsupported })
        : this.pendingKeys
    if (text.length === 0 || this._statusEntry === undefined) {
      this._feedbackEntry?.dispose()
      this._feedbackEntry = undefined
      return
    }
    const entry: IStatusBarEntry = {
      id: VIM_FEEDBACK_ENTRY_ID,
      text,
      tooltip:
        this._unsupported !== undefined
          ? localize('vim.status.unsupportedTooltip', 'Vim: this key has no mapping here')
          : localize('vim.status.pendingTooltip', 'Vim: pending keys'),
      alignment: StatusBarAlignment.Right,
      priority: VIM_STATUS_PRIORITY - 1,
    }
    if (this._feedbackEntry === undefined) {
      this._feedbackEntry = this._statusBarService.addEntry(entry)
    } else {
      this._feedbackEntry.update(entry)
    }
  }

  private syncStatusBar(): void {
    const surface = this._activeSurface
    if (
      !this._enabled ||
      !this._showStatusBar ||
      surface === undefined ||
      !this.isSurfaceEnabled(surface.kind)
    ) {
      this._statusEntry?.dispose()
      this._statusEntry = undefined
      this.syncFeedback()
      return
    }
    const entry = this.statusEntry(surface, this.getMode(surface.surfaceKey, surface.defaultMode))
    if (this._statusEntry === undefined) this._statusEntry = this._statusBarService.addEntry(entry)
    else this._statusEntry.update(entry)
    this.syncFeedback()
  }

  override dispose(): void {
    if (this._unsupportedTimer !== undefined) clearTimeout(this._unsupportedTimer)
    this._unsupportedTimer = undefined
    this._statusEntry?.dispose()
    this._statusEntry = undefined
    this._feedbackEntry?.dispose()
    this._feedbackEntry = undefined
    super.dispose()
  }
}
