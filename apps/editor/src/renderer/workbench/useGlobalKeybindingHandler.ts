/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Global keydown → KeybindingsRegistry resolution → ICommandService.executeCommand.
 *--------------------------------------------------------------------------------------------*/

import { useEffect } from 'react'
import { ICommandService, IContextKeyService, KeybindingsRegistry } from '@universe-editor/platform'
import { useService } from './useService.js'

function buildKeyString(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  if (e.metaKey) parts.push('meta')
  parts.push(e.key.toLowerCase())
  return parts.join('+')
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

export function useGlobalKeybindingHandler(): void {
  const commandService = useService(ICommandService)
  const contextKeyService = useService(IContextKeyService)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target) && !hasFunctionalModifier(e)) return
      const key = buildKeyString(e)
      const commandId = KeybindingsRegistry.resolveKeybinding(key, contextKeyService)
      if (!commandId) return
      e.preventDefault()
      e.stopPropagation()
      void commandService.executeCommand(commandId)
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [commandService, contextKeyService])
}
