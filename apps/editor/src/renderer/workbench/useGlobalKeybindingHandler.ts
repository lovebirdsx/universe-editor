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

function buildKeyString(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  if (e.metaKey) parts.push('meta')
  parts.push(e.key.toLowerCase())
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

    const handler = (e: KeyboardEvent) => {
      if (isModifierOnly(e.key)) return
      // ESC is always processed globally even from editable targets (INPUT / SELECT /
      // contentEditable). Without this exception, pressing ESC inside the Output panel's
      // channel <select> would be silently swallowed and never reach the focus-editor action.
      if (e.key !== 'Escape' && isEditableTarget(e.target) && !hasFunctionalModifier(e)) return

      const key = buildKeyString(e)
      const pending = pendingRef.current
      const result = KeybindingsRegistry.resolveKeystroke(
        key,
        contextKeyService,
        pending ? [pending.key] : undefined,
      )

      if (result.kind === 'execute') {
        e.preventDefault()
        e.stopPropagation()
        clearChord()
        void commandService.executeCommand(result.command)
        return
      }

      if (result.kind === 'enter-chord') {
        e.preventDefault()
        e.stopPropagation()
        enterChord(result.pending[0]!)
        return
      }

      // no-match: if we were mid-chord, the chord is aborted by the next key.
      if (pending) {
        e.preventDefault()
        e.stopPropagation()
        clearChord()
      }
    }

    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', handler)
      clearChord()
    }
  }, [commandService, contextKeyService, statusBarService])
}
