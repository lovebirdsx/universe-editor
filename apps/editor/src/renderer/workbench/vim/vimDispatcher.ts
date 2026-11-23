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
 *    resolve surface (menu > overlay > list/reader > terminal > editor > chrome)
 *    surface switched off in settings → pass
 *    insert → only Esc / Ctrl+[; terminal insert → pass
 *    user binding (weight ≥ User, not reserved) → yield
 *    sequence engine → command | pass | swallow
 *--------------------------------------------------------------------------------------------*/

import {
  ICommandService,
  IContextKeyService,
  KeybindingsRegistry,
  KeybindingWeight,
  ContextKeyExpr,
  type ContextKeyExpression,
} from '@universe-editor/platform'
import {
  getActiveVimSurface,
  isEditableElement,
  isVimSurfaceEngineRegistered,
  resetVimSequences,
  vimKeyToken,
  type IActiveVimSurface,
  type IVimKeymapEntry,
  type VimSurfaceKind,
} from '@universe-editor/workbench-ui'
import { recordPerfPhase } from '../../services/performance/perfPhases.js'
import type { IKeyboardDebugService } from '../../services/keybinding/keyboardDebugService.js'
import { buildKeyString } from '../keybindings/keyEventUtils.js'
import type { IVimModeService, IVimWhichKeyState } from '../../services/vim/vimModeService.js'
import { resolveVimCommandTitle } from '../../services/vim/vimCommandTitle.js'
import {
  formatVimKeys,
  formatVimPending as formatPendingKeys,
} from '../../services/vim/vimKeyFormat.js'
import { isWebviewFocus } from './webviewFocus.js'
import { computeWhichKeyItems } from './vimWhichKeyItems.js'
import {
  formatVimExecute,
  formatVimPassThrough,
  formatVimPending,
  formatVimSurface,
  formatVimUserShadow,
  formatVimWhichKey,
} from './vimDebugFormat.js'

/** Pause after a prefix before the which-key overlay opens. */
export const WHICH_KEY_DELAY_MS = 300

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

function hasRendererDialog(doc: Document): boolean {
  return doc.querySelector('[data-renderer-dialog]') !== null
}

// `when` strings come from the keymap table (bounded) and never change during a
// session, so parsing them once avoids rebuilding the AST on every stroke.
const whenExpressions = new Map<string, ContextKeyExpression | undefined>()

function whenExpression(when: string): ContextKeyExpression | undefined {
  if (whenExpressions.has(when)) return whenExpressions.get(when)
  const expression = ContextKeyExpr.deserialize(when)
  whenExpressions.set(when, expression)
  return expression
}

/**
 * Entries whose `when` fails never take part in matching: otherwise a gated
 * `]c` would still make a plain `]` a pending prefix (which-key, swallowed next
 * key) while its command can never run. Returns the input when nothing is gated.
 */
function entriesWithActiveWhen(
  entries: readonly IVimKeymapEntry[],
  context: IContextKeyService,
): readonly IVimKeymapEntry[] {
  if (!entries.some((entry) => entry.when !== undefined)) return entries
  return entries.filter(
    (entry) => entry.when === undefined || context.contextMatchesRules(whenExpression(entry.when)),
  )
}

function matchRank(entry: IVimKeymapEntry): number {
  if (entry.scope === 'surface') return 0
  return entry.when === undefined ? 2 : 1
}

function mergeCommandArgs(entry: IVimKeymapEntry, rawCount: number): Record<string, unknown> {
  // Vim's implicit count is 1; the sequence engine reports 0 when no digits
  // were typed. `hasCount: true` (only sent for typed digits) keeps the two apart
  // for the few commands where `G` and `1G` mean different things.
  const base: Record<string, unknown> = { count: rawCount > 0 ? rawCount : 1 }
  if (rawCount > 0) base['hasCount'] = true
  if (typeof entry.args === 'object' && entry.args !== null && !Array.isArray(entry.args)) {
    return { ...(entry.args as Record<string, unknown>), ...base }
  }
  return base
}

export class VimDispatcher {
  private readonly _pending = new Map<string, PendingSequence>()
  private _whichKeyTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * The which-key state is one service-wide value but every window has its own
   * dispatcher: only the dispatcher that published it (and only for the surface
   * it was opened on) may treat it as "open" when deciding to skip a timeout or
   * to refresh without the delay, and only it may close it.
   */
  private _whichKeyOwner:
    | { readonly state: IVimWhichKeyState; readonly doc: Document; readonly surfaceKey: string }
    | undefined
  private _disposed = false

  constructor(private readonly _options: VimDispatcherOptions) {}

  /**
   * Returns true when Vim consumed the stroke. The caller (`ctrlNavigationRegistry`
   * provider) performs preventDefault/stopPropagation for a true result.
   */
  handleKeyDown(doc: Document, event: KeyboardEvent): boolean {
    return recordPerfPhase('vim.dispatch', () => this.dispatch(doc, event))
  }

  /** Focus moved: a count typed in one surface must not carry into the next. */
  resetAll(doc?: Document): void {
    this.clearTimers()
    this.clearFeedback()
    if (doc !== undefined) resetVimSequences(doc)
  }

  /** The hook is unmounting: drop timers and any in-flight sequence state. */
  dispose(doc?: Document): void {
    this._disposed = true
    this.resetAll(doc)
  }

  private clearTimers(): void {
    for (const pending of this._pending.values()) clearTimeout(pending.timer)
    this._pending.clear()
  }

  /** The sequence ended (executed, cancelled, broken): drop pending text and which-key. */
  private clearFeedback(): void {
    if (this._whichKeyTimer !== undefined) clearTimeout(this._whichKeyTimer)
    this._whichKeyTimer = undefined
    this._options.vimModeService.setSequencePendingKeys('')
    this.closeWhichKey()
  }

  private ownsWhichKey(doc: Document, surfaceKey: string): boolean {
    const owner = this._whichKeyOwner
    return (
      owner !== undefined &&
      owner.doc === doc &&
      owner.surfaceKey === surfaceKey &&
      this._options.vimModeService.whichKey === owner.state
    )
  }

  private closeWhichKey(): void {
    const owner = this._whichKeyOwner
    this._whichKeyOwner = undefined
    if (owner !== undefined && this._options.vimModeService.whichKey === owner.state) {
      this._options.vimModeService.setWhichKey(undefined)
    }
  }

  /**
   * Which-key opens after a pause on a multi-token prefix, then follows the
   * prefix immediately so walking `<leader> w` updates the list without a second delay.
   */
  private scheduleWhichKey(
    doc: Document,
    active: IActiveVimSurface,
    entries: readonly IVimKeymapEntry[],
    trace: VimTrace,
    debug: IKeyboardDebugService | undefined,
  ): void {
    const vim = this._options.vimModeService
    if (this._whichKeyTimer !== undefined) clearTimeout(this._whichKeyTimer)
    this._whichKeyTimer = undefined
    const prefix = active.sequence.prefix
    if (!vim.getWhichKeyEnabled() || prefix.length === 0) {
      this.closeWhichKey()
      return
    }
    const context = this._options.contextKeyService
    const surfaceKey = active.surfaceKey
    const show = (): void => {
      // The setting may have been switched off while the delay was running.
      if (!vim.getWhichKeyEnabled()) {
        this.closeWhichKey()
        return
      }
      const items = computeWhichKeyItems(
        entries,
        prefix,
        (entry) =>
          entry.when === undefined || context.contextMatchesRules(whenExpression(entry.when)),
        resolveVimCommandTitle,
      )
      if (debug?.enabled) {
        debug.append(formatVimWhichKey(trace, formatVimKeys(prefix), items.length))
      }
      if (items.length === 0) {
        this.closeWhichKey()
        return
      }
      const state: IVimWhichKeyState = { prefix: formatVimKeys(prefix), items }
      this._whichKeyOwner = { state, doc, surfaceKey }
      vim.setWhichKey(state)
    }
    if (this.ownsWhichKey(doc, surfaceKey)) {
      show()
      return
    }
    this._whichKeyTimer = setTimeout(() => {
      this._whichKeyTimer = undefined
      if (!this._disposed && active.sequence.isPending) show()
    }, WHICH_KEY_DELAY_MS)
  }

  private dispatch(doc: Document, event: KeyboardEvent): boolean {
    if (this._disposed) return false
    if (event.defaultPrevented) return false
    if (event.isComposing || event.keyCode === 229) return false
    const vim = this._options.vimModeService
    if (!vim.getEnabled()) return false
    if (isWebviewFocus(doc)) return false
    if (this._options.contextKeyService.get('quickInputVisible') === true) return false

    // Modifier-only keypresses carry no Vim token and must not disrupt a pending sequence.
    if (
      event.key === 'Shift' ||
      event.key === 'Control' ||
      event.key === 'Alt' ||
      event.key === 'Meta'
    ) {
      return false
    }

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
      // Only editors reach Insert in practice (terminals were handled above).
      // Ctrl+[ is Esc as in Vim, on editors too: the core leaves Insert instead
      // of Monaco outdenting the line.
      if (token !== 'escape' && token !== 'ctrl+[') return false
      // Keep checking the dialog here: opening the settings modal while an
      // editor is in Insert mode must still leave Escape to the dialog.
      if (hasRendererDialog(doc)) return false
      if (kind === 'editor') return this.editorStroke(active, event)
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

    // Checked only once a registered, enabled surface is about to act: this
    // query runs on every Normal stroke and must stay off the Insert/IME path.
    if (hasRendererDialog(doc)) return false

    // User keybindings outrank Vim except for the small reserved set (Esc/i/a/:
    // /?/leader by default) and while a sequence is in flight: the second
    // stroke of `<leader>X` belongs to the leader command even if the user
    // bound `X` globally, otherwise the engine would stay pending forever.
    const sequencePending = active.sequence.isPending
    const reserved = this.isReserved(token)
    if (!reserved && !sequencePending) {
      const keyString = buildKeyString(event)
      if (
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
    }

    if (debug?.enabled) debug.append(formatVimSurface(trace))

    if (kind === 'editor') {
      // The leader and an in-flight sequence belong to the shared engine even
      // on editors; every other Normal-mode stroke is the editor's Vim core.
      if (this.dispatchEditorSequence(doc, active, token, surfaceKey, trace, debug)) return true
      return this.editorStroke(active, event)
    }

    active.sequence.setEntries(
      entriesWithActiveWhen(
        vim.getEffectiveKeymap(kind, active.keymap),
        this._options.contextKeyService,
      ),
    )
    return this.feedSequence(doc, active, token, surfaceKey, trace, debug, (typed) =>
      this.handleUnmapped(kind, token, event, typed, trace, debug),
    )
  }

  /**
   * Editors own their Vim core (counts, operators, search) and normally bypass
   * the shared sequence engine. The configured leader and a sequence already
   * pending on this surface are workbench commands, so they go through the
   * engine; a broken prefix falls back to the controller like any other key.
   */
  private dispatchEditorSequence(
    doc: Document,
    active: IActiveVimSurface,
    token: string,
    surfaceKey: string,
    trace: VimTrace,
    debug: IKeyboardDebugService | undefined,
  ): boolean {
    const vim = this._options.vimModeService
    // `r<Space>` / `f<Space>`: the core is waiting for a literal character, so
    // the leader is that character and must not open a leader sequence.
    if (active.surface.actions.isAwaitingCharArg?.() === true) return false
    if (token !== vim.getLeader() && !active.sequence.isPending) return false
    active.sequence.setEntries(
      entriesWithActiveWhen(
        vim.getEffectiveKeymap('editor', active.keymap),
        this._options.contextKeyService,
      ),
    )
    // An unmatched token is the controller's: it was never ours to swallow.
    return this.feedSequence(doc, active, token, surfaceKey, trace, debug, () => false, true)
  }

  /**
   * Feed one token and act on the step. A token that merely ended a deferred
   * match (`z` waiting for `za`, then `j`) is fed again after the match ran so
   * it still counts; `editor` hands such a token back to the controller instead,
   * because counts and operators there are the Vim core's, not the engine's.
   */
  private feedSequence(
    doc: Document,
    active: IActiveVimSurface,
    token: string,
    surfaceKey: string,
    trace: VimTrace,
    debug: IKeyboardDebugService | undefined,
    onUnmatched: (typed: readonly string[]) => boolean,
    editor = false,
  ): boolean {
    const vim = this._options.vimModeService
    // What the user typed for the current attempt, for the unsupported-key notice.
    let typed: readonly string[] = [...active.sequence.prefix, token]
    let step = active.sequence.feed(token)
    for (;;) {
      switch (step.kind) {
        case 'cancel':
          this.clearPending(surfaceKey)
          this.clearFeedback()
          return true
        case 'pending':
          this.armPending(active, doc, surfaceKey, trace)
          vim.setSequencePendingKeys(formatPendingKeys(step.count, step.prefix))
          this.scheduleWhichKey(
            doc,
            active,
            vim.getEffectiveKeymap(active.surface.kind, active.keymap),
            trace,
            debug,
          )
          if (debug?.enabled) debug.append(formatVimPending(trace, [...step.prefix]))
          return true
        case 'execute':
          this.clearPending(surfaceKey)
          this.clearFeedback()
          this.runMatches(step.matches, step.count, trace, debug)
          if (step.replay !== true) return true
          if (editor && token !== vim.getLeader()) return false
          typed = [token]
          step = active.sequence.feed(token)
          continue
        case 'none':
          this.clearPending(surfaceKey)
          this.clearFeedback()
          return onUnmatched(typed)
      }
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

  private armPending(
    active: IActiveVimSurface,
    doc: Document,
    surfaceKey: string,
    trace: VimTrace,
  ): void {
    this.clearPending(surfaceKey)
    const timeoutMs = this._options.vimModeService.getSequenceTimeoutMs()
    const timer = setTimeout(() => {
      this._pending.delete(surfaceKey)
      // The surface may have unmounted while the timer was in flight.
      if (this._disposed || !isVimSurfaceEngineRegistered(doc, active.sequence)) return
      // An open which-key list is reading time: only Esc, a key or a focus change
      // ends the sequence. A deferred match (`z` before `za`) still runs on timeout.
      if (this.ownsWhichKey(doc, surfaceKey) && !active.sequence.hasDeferredMatch) return
      const step = active.sequence.flush()
      this.clearFeedback()
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
    // Narrower meanings win over registration order: what the active surface
    // declared itself (settings-only `/`), then `when`-gated entries (chat-only
    // `i`), then the kind-wide default.
    const ordered = [...matches].sort((a, b) => matchRank(a) - matchRank(b))
    const entry = ordered.find((candidate) => {
      if (candidate.when === undefined) return true
      return context.contextMatchesRules(whenExpression(candidate.when))
    })
    if (entry === undefined) {
      // Keys matched but every `when` failed: consumed, so tell the user why nothing ran.
      const first = matches[0]
      if (first !== undefined) {
        this._options.vimModeService.reportUnsupportedKey(formatVimKeys(first.keys))
      }
      return
    }
    if (debug?.enabled) debug.append(formatVimExecute(trace, entry.command, count))
    void this._options.commandService
      .executeCommand(entry.command, mergeCommandArgs(entry, count))
      .catch((error: unknown) => {
        console.error(`[vim] command failed: ${entry.command}`, error)
      })
  }

  private handleUnmapped(
    kind: VimSurfaceKind,
    token: string,
    event: KeyboardEvent,
    typed: readonly string[],
    trace: VimTrace,
    debug: IKeyboardDebugService | undefined,
  ): boolean {
    if (this._options.vimModeService.getPassThroughUnmappedKeys()) return false
    if (!PRINTABLE_SWALLOW_KINDS.has(kind)) return false
    if (token.length !== 1 || event.ctrlKey || event.altKey || event.metaKey) return false
    if (debug?.enabled) debug.append(formatVimPassThrough(trace, 'unmapped printable key'))
    this._options.vimModeService.reportUnsupportedKey(formatVimKeys(typed))
    return true
  }
}
