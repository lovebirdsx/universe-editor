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
  KeybindingsRegistry,
  StatusBarAlignment,
  type IDisposable,
} from '@universe-editor/platform'
import { useService } from './useService.js'
import { formatChord } from './titlebar/keybindingFormat.js'

const CHORD_TIMEOUT_MS = 1500

// Map browser KeyboardEvent.key values to our canonical key names where they differ.
const DOM_KEY_MAP: Record<string, string> = {
  arrowleft: 'left',
  arrowright: 'right',
  arrowup: 'up',
  arrowdown: 'down',
}

function buildKeyString(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  if (e.metaKey) parts.push('meta')
  const raw = e.key.toLowerCase()
  parts.push(DOM_KEY_MAP[raw] ?? raw)
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

export function useGlobalKeybindingHandler(): void {
  const commandService = useService(ICommandService)
  const contextKeyService = useService(IContextKeyService)
  const statusBarService = useService(IStatusBarService)
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

    // Registered on document in capture phase so we intercept keydown events
    // before any inner-element handler (including Monaco's chord dispatcher)
    // can call stopPropagation() and hide the event from a window-level bubble
    // listener. Capture phase fires outer→inner, so document fires before any
    // Monaco container element.
    const handler = (e: KeyboardEvent) => {
      if (isModifierOnly(e.key)) return
      // RendererDialogService dialogs handle their own keyboard events; never
      // intercept from inside them (would prevent Escape from closing dialogs).
      if (isInsideRendererDialog(e.target)) return

      const pending = pendingRef.current
      if (pending) {
        // In chord mode — claim the second stroke unconditionally.
        // Prevents Monaco from also acting on the keystroke that completes
        // (or aborts) our chord.
        const secondKey = buildKeyString(e)
        const result = KeybindingsRegistry.resolveKeystroke(secondKey, contextKeyService, [
          pending.key,
        ])
        e.preventDefault()
        e.stopPropagation()
        clearChord()
        if (result.kind === 'execute') {
          void commandService.executeCommand(result.command)
        }
        return
      }

      const key = buildKeyString(e)
      const result = KeybindingsRegistry.resolveKeystroke(key, contextKeyService, undefined)
      if (result.kind === 'no-match') return

      // Reserve printable single-character keys (without ctrl/alt/meta) for
      // text input when focus is in an editable target — even if someone
      // bound such a key globally. Function keys, Escape, Arrows, Tab etc.
      // are length > 1 and pass through.
      const isPrintableTyping =
        e.key.length === 1 && !hasFunctionalModifier(e) && isEditableTarget(e.target)
      if (isPrintableTyping || isNativeEditableKey(e)) return

      e.preventDefault()
      e.stopPropagation()
      if (result.kind === 'execute') {
        void commandService.executeCommand(result.command)
      } else {
        enterChord(result.pending[0]!)
      }
    }

    document.addEventListener('keydown', handler, true)
    return () => {
      document.removeEventListener('keydown', handler, true)
      clearChord()
    }
  }, [commandService, contextKeyService, statusBarService])
}
