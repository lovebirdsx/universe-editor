/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Vim dispatch — decides whether one keydown belongs to Vim, which surface owns
 *  it and what command to run. Pure class (no React, no listeners); the
 *  `useVimDispatcher` hook installs it as the `workbench-ui` window-capture
 *  provider and feeds every document.
 *
 *  Order matters and mirrors the plan:
 *    defaultPrevented / IME / chord → pass
 *    vim.enabled off / webview / dialog / quick input → pass
 *    resolve surface (menu > overlay > list > terminal > editor > chrome)
 *    insert → only Esc; terminal insert → pass
 *    user binding (weight ≥ User, not reserved) → yield
 *    sequence engine → command | pass | swallow
 *--------------------------------------------------------------------------------------------*/

import {
  ICommandService,
  IContextKeyService,
  KeybindingsRegistry,
  KeybindingWeight,
  ContextKeyExpr,
} from '@universe-editor/platform'
import {
  getActiveVimSurface,
  isEditableElement,
  vimKeyToken,
  type IActiveVimSurface,
  type IVimKeymapEntry,
  type VimSurfaceKind,
} from '@universe-editor/workbench-ui'
import { recordPerfPhase } from '../../services/performance/perfPhases.js'
import type { IKeyboardDebugService } from '../../services/keybinding/keyboardDebugService.js'
import { buildKeyString } from '../keybindings/keyEventUtils.js'
import type { IVimModeService } from '../../services/vim/vimModeService.js'
import {
  formatVimExecute,
  formatVimPassThrough,
  formatVimPending,
  formatVimSurface,
  formatVimUserShadow,
} from './vimDebugFormat.js'

const PRINTABLE_SWALLOW_KINDS: ReadonlySet<VimSurfaceKind> = new Set([
  'list',
  'menu',
  'overlay',
  'terminal',
])

interface PendingSequence {
  readonly timer: ReturnType<typeof setTimeout>
}

type VimTrace = { readonly surface: string; readonly surfaceId: string; readonly mode: string }

export interface VimDispatcherOptions {
  readonly commandService: ICommandService
  readonly contextKeyService: IContextKeyService
  readonly vimModeService: IVimModeService
  readonly keyboardDebugService?: IKeyboardDebugService | undefined
}

function isWebviewFocus(doc: Document): boolean {
  const active = doc.activeElement
  if (active === null) return false
  if (active.tagName.toUpperCase() === 'IFRAME') return true
  const marked = active.closest?.('[data-vim-surface="webview"]')
  return marked !== null && marked !== undefined
}

function hasRendererDialog(doc: Document): boolean {
  return doc.querySelector('[data-renderer-dialog]') !== null
}

function mergeCommandArgs(entry: IVimKeymapEntry, rawCount: number): Record<string, unknown> {
  // Vim's implicit count is 1; the sequence engine reports 0 when no digits
  // were typed, but adapters should never have to special-case it.
  const base: Record<string, unknown> = { count: rawCount > 0 ? rawCount : 1 }
  if (typeof entry.args === 'object' && entry.args !== null && !Array.isArray(entry.args)) {
    return { ...(entry.args as Record<string, unknown>), ...base }
  }
  return base
}

export class VimDispatcher {
  private readonly _pending = new Map<string, PendingSequence>()

  constructor(private readonly _options: VimDispatcherOptions) {}

  /**
   * Returns true when Vim consumed the stroke. The caller (`ctrlNavigationRegistry`
   * provider) performs preventDefault/stopPropagation for a true result.
   */
  handleKeyDown(doc: Document, event: KeyboardEvent): boolean {
    return recordPerfPhase('vim.dispatch', () => this.dispatch(doc, event))
  }

  /** Focus moved: a count typed in one surface must not carry into the next. */
  resetAll(): void {
    for (const pending of this._pending.values()) clearTimeout(pending.timer)
    this._pending.clear()
  }

  private dispatch(doc: Document, event: KeyboardEvent): boolean {
    if (event.defaultPrevented) return false
    if (event.isComposing || event.keyCode === 229) return false
    const vim = this._options.vimModeService
    if (!vim.getEnabled()) return false
    if (isWebviewFocus(doc)) return false
    if (hasRendererDialog(doc)) return false
    if (this._options.contextKeyService.get('quickInputVisible') === true) return false

    const active = getActiveVimSurface(doc)
    if (active === undefined) return false
    const { surface, surfaceKey } = active
    const kind = surface.kind
    if (!vim.isSurfaceEnabled(kind)) return false

    const mode = vim.getMode(surfaceKey, surface.defaultMode)
    this.reportActiveSurface(active, kind, surfaceKey)
    const trace = { surface: kind, surfaceId: surface.id, mode }
    const debug = this._options.keyboardDebugService

    const token = vimKeyToken(event)

    // Terminal shells are an editable text surface until Normal Mode is asked
    // for; the xterm textarea is a TEXTAREA, so this branch must come before
    // the generic editable guard.
    if (kind === 'terminal' && mode !== 'terminal-normal') return false

    if (mode === 'insert') {
      if (token !== 'escape') return false
      if (kind === 'editor') return this.editorStroke(active, event)
      // Non-editor surfaces have no insert mode of their own; Esc returns to
      // Normal so the next keystroke is Vim's again.
      vim.setMode(surfaceKey, 'normal')
      return true
    }

    // Editor and terminal own editable DOM by design (Monaco's textarea, the
    // xterm textarea); everything else yields so an inline search box types.
    if (kind !== 'editor' && kind !== 'terminal') {
      const activeElement = doc.activeElement
      if (activeElement !== null && isEditableElement(activeElement)) {
        if (debug?.enabled) debug.append(formatVimPassThrough(trace, 'editable target'))
        return false
      }
    }

    // User keybindings outrank Vim except for the small reserved set (Esc/i/a/:
    // /?/leader by default). Ctrl+F/B/D/U are deliberately not reserved.
    const keyString = buildKeyString(event)
    const reserved = this.isReserved(token)
    if (
      !reserved &&
      KeybindingsRegistry.hasBindingAtOrAbove(
        keyString,
        KeybindingWeight.User,
        this._options.contextKeyService,
      )
    ) {
      if (debug?.enabled) {
        const command = this.userCommand(keyString)
        debug.append(formatVimUserShadow(trace, command ?? '<unknown>'))
      }
      return false
    }

    if (debug?.enabled) debug.append(formatVimSurface(trace))

    if (kind === 'editor') {
      // The leader and an in-flight sequence belong to the shared engine even
      // on editors; every other Normal-mode stroke is the editor's Vim core.
      if (this.dispatchEditorSequence(active, token, surfaceKey, trace, debug)) return true
      return this.editorStroke(active, event)
    }

    const surfaceKeys = vim.getEffectiveKeymap(kind)
    active.sequence.setEntries(surfaceKeys)
    const step = active.sequence.feed(token)
    switch (step.kind) {
      case 'cancel':
        this.clearPending(surfaceKey)
        return true
      case 'pending':
        this.armPending(active, surfaceKey, trace)
        if (debug?.enabled) {
          debug.append(formatVimPending(trace, [...step.prefix]))
        }
        return true
      case 'execute':
        this.clearPending(surfaceKey)
        this.runMatches(step.matches, step.count, trace, debug)
        return true
      case 'none':
        this.clearPending(surfaceKey)
        return this.handleUnmapped(kind, token, event, trace, debug)
    }
  }

  /**
   * Editors own their Vim core (counts, operators, search) and normally bypass
   * the shared sequence engine. The configured leader and a sequence already
   * pending on this surface are workbench commands, so they go through the
   * engine; a broken prefix falls back to the controller like any other key.
   */
  private dispatchEditorSequence(
    active: IActiveVimSurface,
    token: string,
    surfaceKey: string,
    trace: VimTrace,
    debug: IKeyboardDebugService | undefined,
  ): boolean {
    const vim = this._options.vimModeService
    if (token !== vim.getLeader() && !active.sequence.isPending) return false
    active.sequence.setEntries(vim.getEffectiveKeymap('editor'))
    const step = active.sequence.feed(token)
    switch (step.kind) {
      case 'cancel':
        this.clearPending(surfaceKey)
        return true
      case 'pending':
        this.armPending(active, surfaceKey, trace)
        if (debug?.enabled) debug.append(formatVimPending(trace, [...step.prefix]))
        return true
      case 'execute':
        this.clearPending(surfaceKey)
        this.runMatches(step.matches, step.count, trace, debug)
        return true
      case 'none':
        this.clearPending(surfaceKey)
        return false
    }
  }

  private editorStroke(active: IActiveVimSurface, event: KeyboardEvent): boolean {
    return active.surface.actions.handleStroke?.(event) === true
  }

  private reportActiveSurface(
    active: IActiveVimSurface,
    kind: VimSurfaceKind,
    surfaceKey: string,
  ): void {
    this._options.vimModeService.activateSurface({
      surfaceKey,
      kind,
      id: active.surface.id,
      defaultMode: active.surface.defaultMode,
    })
  }

  private isReserved(token: string): boolean {
    return this._options.vimModeService.reservedKeys.includes(token)
  }

  private userCommand(keyString: string): string | undefined {
    const resolved = KeybindingsRegistry.resolveKeystroke(
      keyString,
      this._options.contextKeyService,
    )
    return resolved.kind === 'execute' && resolved.weight >= KeybindingWeight.User
      ? resolved.command
      : undefined
  }

  private armPending(active: IActiveVimSurface, surfaceKey: string, trace: VimTrace): void {
    this.clearPending(surfaceKey)
    const timeoutMs = this._options.vimModeService.getSequenceTimeoutMs()
    const timer = setTimeout(() => {
      this._pending.delete(surfaceKey)
      const step = active.sequence.flush()
      if (step.kind === 'execute') this.runMatches(step.matches, step.count, trace, undefined)
    }, timeoutMs)
    this._pending.set(surfaceKey, { timer })
  }

  private clearPending(surfaceKey: string): void {
    const pending = this._pending.get(surfaceKey)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this._pending.delete(surfaceKey)
  }

  private runMatches(
    matches: readonly IVimKeymapEntry[],
    count: number,
    trace: VimTrace,
    debug: IKeyboardDebugService | undefined,
  ): void {
    const context = this._options.contextKeyService
    const entry = matches.find((candidate) => {
      if (candidate.when === undefined) return true
      return context.contextMatchesRules(ContextKeyExpr.deserialize(candidate.when))
    })
    if (entry === undefined) return
    if (debug?.enabled) debug.append(formatVimExecute(trace, entry.command, count))
    console.debug(`[vim] execute ${entry.command} count=${count}`)
    void this._options.commandService.executeCommand(entry.command, mergeCommandArgs(entry, count))
  }

  private handleUnmapped(
    kind: VimSurfaceKind,
    token: string,
    event: KeyboardEvent,
    trace: VimTrace,
    debug: IKeyboardDebugService | undefined,
  ): boolean {
    if (this._options.vimModeService.getPassThroughUnmappedKeys()) return false
    if (!PRINTABLE_SWALLOW_KINDS.has(kind)) return false
    if (token.length !== 1 || event.ctrlKey || event.altKey || event.metaKey) return false
    if (debug?.enabled) debug.append(formatVimPassThrough(trace, 'unmapped printable key'))
    return true
  }
}
