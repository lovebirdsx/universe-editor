/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Global keydown → KeybindingsRegistry chord state machine → command execution.
 *  Supports single-stroke and 2-stroke chord bindings (e.g. Ctrl+K Ctrl+S),
 *  with transient status-bar feedback while a chord is pending.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef } from 'react'
import {
  ICommandService,
  IContextKeyService,
  IStatusBarService,
  CommandsRegistry,
  KeybindingsRegistry,
  StatusBarAlignment,
  type IDisposable,
} from '@universe-editor/platform'
import { useService } from './useService.js'
import { formatChord } from './titlebar/keybindingFormat.js'
import { IKeyboardDebugService } from '../services/keybinding/keyboardDebugService.js'
import { IUserKeybindingsService } from '../services/keybindings/UserKeybindingsService.js'
import { MonacoLoader } from './editor/monaco/MonacoLoader.js'
import { monacoDeferDecision } from './editor/monaco/monacoActionsBridge.js'
import {
  formatGuardStop,
  formatKeystrokeTrace,
  type KeyEventDiagnostics,
} from '../services/keybinding/keyboardDebugFormat.js'

const CHORD_TIMEOUT_MS = 1500

// Map browser KeyboardEvent.key values to our canonical key names where they differ.
const DOM_KEY_MAP: Record<string, string> = {
  arrowleft: 'left',
  arrowright: 'right',
  arrowup: 'up',
  arrowdown: 'down',
}

// Shift mutates `e.key` for the number row (e.g. 5 → %, ` → ~), so those keys
// would build as `ctrl+shift+%` and never match a `ctrl+shift+5` binding.
// Resolve them from the layout-independent `e.code` instead.
const CODE_KEY_MAP: Record<string, string> = {
  Digit0: '0',
  Digit1: '1',
  Digit2: '2',
  Digit3: '3',
  Digit4: '4',
  Digit5: '5',
  Digit6: '6',
  Digit7: '7',
  Digit8: '8',
  Digit9: '9',
  Backquote: '`',
}
const QUICK_INPUT_NATIVE_NAVIGATION_KEYS = new Set(['arrowleft', 'arrowright', 'home', 'end'])
const QUICK_INPUT_NATIVE_PRIMARY_SHORTCUTS = new Set(['a', 'c', 'v', 'x', 'z', 'y'])
const QUICK_INPUT_OWNED_KEYS = new Set(['enter', 'arrowup', 'arrowdown', 'pageup', 'pagedown'])

function buildKeyString(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  if (e.metaKey) parts.push('meta')
  const raw = e.key.toLowerCase()
  parts.push(CODE_KEY_MAP[e.code] ?? DOM_KEY_MAP[raw] ?? raw)
  return parts.join('+')
}

function isModifierOnly(key: string): boolean {
  const k = key.toLowerCase()
  return k === 'control' || k === 'shift' || k === 'alt' || k === 'meta'
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable
}

// Treat ctrl / alt / meta as "functional" modifiers. Shift alone is part of
// normal text input (e.g. typing capital letters) and must not bypass the
// editable-target guard.
function hasFunctionalModifier(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.altKey || e.metaKey
}

function isNativeEditableKey(e: KeyboardEvent): boolean {
  if (!isEditableTarget(e.target)) return false
  const key = e.key.toLowerCase()
  return key === 'delete' || key === 'backspace'
}

function isQuickInputNativeEditingKey(e: KeyboardEvent): boolean {
  if (!isEditableTarget(e.target)) return false

  const key = e.key.toLowerCase()
  if (e.key.length === 1 && !hasFunctionalModifier(e)) return true
  if (isNativeEditableKey(e)) return true

  if (QUICK_INPUT_NATIVE_NAVIGATION_KEYS.has(key)) return true

  const primaryModifier = e.ctrlKey || e.metaKey
  if (!primaryModifier) return false

  return QUICK_INPUT_NATIVE_PRIMARY_SHORTCUTS.has(key)
}

function isQuickInputOwnedKey(e: KeyboardEvent): boolean {
  const key = e.key.toLowerCase()
  if (QUICK_INPUT_OWNED_KEYS.has(key)) return true
  return (
    e.ctrlKey &&
    !e.altKey &&
    !e.metaKey &&
    !e.shiftKey &&
    (key === 'n' || key === 'p') &&
    isEditableTarget(e.target)
  )
}

// Modal dialogs rendered by RendererDialogService own their keyboard events
// entirely. Walk up from the event target to detect if we're inside one.
function isInsideRendererDialog(target: EventTarget | null): boolean {
  let el = target instanceof HTMLElement ? target : null
  while (el) {
    if (el.dataset['rendererDialog'] !== undefined) return true
    el = el.parentElement
  }
  return false
}

interface PendingChord {
  key: string
  entry: IDisposable
  timer: ReturnType<typeof setTimeout>
}

function diagTime(): string {
  const d = new Date()
  const pad = (n: number, len = 2) => String(n).padStart(len, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

function toDiagnostics(e: KeyboardEvent, builtKey: string): KeyEventDiagnostics {
  const targetTag = e.target instanceof HTMLElement ? e.target.tagName : '<non-element>'
  return {
    time: diagTime(),
    code: e.code,
    key: e.key,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    meta: e.metaKey,
    isComposing: e.isComposing,
    builtKey,
    targetTag,
    isEditable: isEditableTarget(e.target),
  }
}

export function useGlobalKeybindingHandler(): void {
  const commandService = useService(ICommandService)
  const contextKeyService = useService(IContextKeyService)
  const statusBarService = useService(IStatusBarService)
  const keyboardDebugService = useService(IKeyboardDebugService)
  const userKeybindings = useService(IUserKeybindingsService)
  const pendingRef = useRef<PendingChord | null>(null)

  useEffect(() => {
    function clearChord() {
      const p = pendingRef.current
      if (!p) return
      clearTimeout(p.timer)
      p.entry.dispose()
      pendingRef.current = null
    }

    function enterChord(key: string) {
      clearChord()
      const entry = statusBarService.addEntry({
        text: `(${formatChord([key])}) was pressed. Waiting for second key…`,
        alignment: StatusBarAlignment.Left,
        priority: 10_000,
      })
      const timer = setTimeout(() => clearChord(), CHORD_TIMEOUT_MS)
      pendingRef.current = { key, entry, timer }
    }

    // Single document capture-phase listener. It always runs *before* Monaco's
    // own dispatch, then decides per keystroke who wins:
    //
    //  - Editor NOT focused → resolve against the project registry directly
    //    (status quo): global shortcuts stay authoritative.
    //
    //  - Editor focused → consult `monacoDeferDecision`. Keys that are Monaco
    //    defaults (or a chord prefix) are *deferred* — we return without
    //    preventDefault so the event reaches Monaco's dispatcher (Find, ESC,
    //    IntelliSense, Ctrl+K chords keep working). A Monaco default the user
    //    has rebound is *swallowed* (preventDefault + stopPropagation) so
    //    Monaco's original key is dead and the user's binding runs instead.
    //    Everything else *proceeds* to the project registry; keys with no
    //    project binding fall through to Monaco via the no-match return.
    //
    // This removes the old bubble listener and its `e.defaultPrevented` probe:
    // "did Monaco consume this" is now answered by the explicit defer table
    // rather than by inspecting Monaco's side effects.
    const runResolution = (e: KeyboardEvent) => {
      const dbg = keyboardDebugService.enabled
      // IME composition owns every keystroke until it commits. keyCode 229 is
      // the legacy "composition" sentinel Chromium reports while e.isComposing
      // is true, so guarding on either keeps multi-cursor / chord shortcuts from
      // misfiring mid-composition (matches VSCode's _dispatch IME guard).
      if (e.isComposing || e.keyCode === 229) {
        if (dbg) {
          keyboardDebugService.append(
            formatGuardStop(toDiagnostics(e, buildKeyString(e)), 'IME composition in progress'),
          )
        }
        return
      }
      if (isModifierOnly(e.key)) {
        if (dbg) {
          keyboardDebugService.append(
            formatGuardStop(
              toDiagnostics(e, e.key.toLowerCase()),
              'modifier key alone (no stroke)',
            ),
          )
        }
        return
      }
      // RendererDialogService dialogs handle their own keyboard events; never
      // intercept from inside them (would prevent Escape from closing dialogs).
      if (isInsideRendererDialog(e.target)) {
        if (dbg) {
          keyboardDebugService.append(
            formatGuardStop(
              toDiagnostics(e, buildKeyString(e)),
              'focus is inside a modal dialog (dialog owns its keys)',
            ),
          )
        }
        return
      }

      if (contextKeyService.get('quickInputVisible') === true) {
        clearChord()
        const key = buildKeyString(e)
        if (isQuickInputNativeEditingKey(e) || isQuickInputOwnedKey(e)) {
          if (dbg) {
            keyboardDebugService.append(
              formatGuardStop(
                toDiagnostics(e, key),
                'Quick Input is open and owns this key (native editing/navigation)',
              ),
            )
          }
          return
        }

        const result = KeybindingsRegistry.resolveKeystroke(key, contextKeyService, undefined)
        if (dbg) {
          const trace = KeybindingsRegistry.traceKeystroke(key, contextKeyService, undefined)
          const note =
            result.kind === 'execute' && e.key.toLowerCase() !== 'escape'
              ? '\n  ⤫ Quick Input is open: only Escape is honored, command not run'
              : result.kind === 'no-match'
                ? '\n  ⤫ Quick Input is open: key not bound, passed to Quick Input'
                : ''
          keyboardDebugService.append(formatKeystrokeTrace(toDiagnostics(e, key), trace) + note)
        }
        if (result.kind === 'no-match') return

        e.preventDefault()
        e.stopPropagation()
        if (result.kind === 'execute' && e.key.toLowerCase() === 'escape') {
          void commandService.executeCommand(
            result.command,
            ...(result.args !== undefined ? [result.args] : []),
          )
        }
        return
      }

      const pending = pendingRef.current
      if (pending) {
        // In chord mode — claim the second stroke unconditionally.
        // Prevents Monaco from also acting on the keystroke that completes
        // (or aborts) our chord.
        const secondKey = buildKeyString(e)
        const result = KeybindingsRegistry.resolveKeystroke(secondKey, contextKeyService, [
          pending.key,
        ])
        if (dbg) {
          const trace = KeybindingsRegistry.traceKeystroke(secondKey, contextKeyService, [
            pending.key,
          ])
          const note =
            result.kind === 'no-match'
              ? '\n  ⤫ second key did not complete a chord — chord cancelled'
              : ''
          keyboardDebugService.append(
            formatKeystrokeTrace(toDiagnostics(e, secondKey), trace) + note,
          )
        }
        clearChord()
        if (result.kind === 'execute' && !CommandsRegistry.getCommand(result.command)) {
          if (dbg) {
            keyboardDebugService.append(
              formatGuardStop(
                toDiagnostics(e, secondKey),
                `command not registered: ${result.command}`,
              ),
            )
          }
          return
        }
        e.preventDefault()
        e.stopPropagation()
        if (result.kind === 'execute') {
          void commandService.executeCommand(
            result.command,
            ...(result.args !== undefined ? [result.args] : []),
          )
        }
        return
      }

      const key = buildKeyString(e)

      // Editor-focus arbitration (replaces the old bubble + defaultPrevented
      // route). Defer Monaco's own default keys to Monaco; swallow the original
      // key of a command the user has rebound so it doesn't fire twice.
      if (contextKeyService.get('editorFocus') === true) {
        const decision = monacoDeferDecision(
          key,
          (id) => userKeybindings.getUserEntry(id) !== undefined,
        )
        if (decision === 'defer') {
          if (dbg) {
            keyboardDebugService.append(
              formatGuardStop(
                toDiagnostics(e, key),
                'editor focused: Monaco owns this default key',
              ),
            )
          }
          return
        }
        if (decision === 'swallow') {
          // Kill Monaco's original default key, then fall through so the user's
          // own binding (if any) resolves below.
          e.preventDefault()
          e.stopPropagation()
        }
      }

      const result = KeybindingsRegistry.resolveKeystroke(key, contextKeyService, undefined)
      const diag = dbg ? toDiagnostics(e, key) : undefined
      if (dbg && diag) {
        const trace = KeybindingsRegistry.traceKeystroke(key, contextKeyService, undefined)
        keyboardDebugService.append(formatKeystrokeTrace(diag, trace))
        if (result.kind === 'no-match') {
          const all = KeybindingsRegistry.getAllKeybindings()
          const sameKey = all.filter(
            (kb) => (kb.chords ? kb.chords[0] : kb.key)?.toLowerCase() === key,
          )
          const d = userKeybindings.diagnostics
          const cmds = CommandsRegistry.getCommands()
          let editorActionCmds = 0
          for (const id of cmds.keys()) if (id.startsWith('editor.action.')) editorActionCmds++
          const hasCopy = cmds.has('editor.action.copyLinesDownAction')
          keyboardDebugService.append(
            `  diag: registry=${all.length} bindings | same-key(ignoring when)=${sameKey.length}` +
              ` | monaco bridged=${MonacoLoader.actionsBridged}` +
              ` | cmds total=${cmds.size} editor.action.*=${editorActionCmds} hasCopyLinesDown=${hasCopy}` +
              ` | vscode-keybindings: parsed=${d.vscodeParsedCount} registered=${d.vscodeRegisteredCount}` +
              ` path=${d.vscodeFilePath ?? '<unresolved>'}`,
          )
        }
      }
      if (result.kind === 'no-match') return

      // Reserve printable single-character keys (without ctrl/alt/meta) and the
      // native editing keys (Delete/Backspace) for text input. A focused Monaco
      // editor counts as a text surface even though its EditContext host is not
      // a DOM-editable element — `editorTextFocus` is the reliable signal — so a
      // global Delete binding (e.g. delete-file) never steals the editor's key.
      const inTextSurface =
        isEditableTarget(e.target) || contextKeyService.get('editorTextFocus') === true
      const k = e.key.toLowerCase()
      const isPrintableTyping = e.key.length === 1 && !hasFunctionalModifier(e) && inTextSurface
      const isNativeEditing = inTextSurface && (k === 'delete' || k === 'backspace')
      if (isPrintableTyping || isNativeEditing) {
        if (dbg && diag) {
          keyboardDebugService.append(
            formatGuardStop(
              diag,
              'key reserved for text input (editable target, no functional modifier)',
            ),
          )
        }
        return
      }

      if (result.kind === 'execute' && !CommandsRegistry.getCommand(result.command)) {
        if (dbg && diag) {
          keyboardDebugService.append(
            formatGuardStop(diag, `command not registered: ${result.command}`),
          )
        }
        return
      }

      e.preventDefault()
      e.stopPropagation()
      if (result.kind === 'execute') {
        void commandService.executeCommand(
          result.command,
          ...(result.args !== undefined ? [result.args] : []),
        )
      } else {
        enterChord(result.pending[0]!)
      }
    }

    // One capture-phase listener for the whole document. Editor-focus
    // arbitration lives inside runResolution (monacoDeferDecision), so there is
    // no second bubble listener and no dependency on e.defaultPrevented.
    const captureHandler = (e: KeyboardEvent) => {
      runResolution(e)
    }

    document.addEventListener('keydown', captureHandler, true)
    return () => {
      document.removeEventListener('keydown', captureHandler, true)
      clearChord()
    }
  }, [commandService, contextKeyService, statusBarService, keyboardDebugService, userKeybindings])
}
