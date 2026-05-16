/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Hook that subscribes to MenuRegistry and resolves menu items into UI-ready
 *  sections (grouped, with label + shortcut filled in).
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import {
  CommandsRegistry,
  IContextKeyService,
  KeybindingsRegistry,
  MenuRegistry,
} from '@universe-editor/platform'
import type { IMenuItem, MenuId } from '@universe-editor/platform'
import { useService } from '../useService.js'

export interface ResolvedMenuItem {
  command: string
  label: string
  shortcut?: string
}

export interface ResolvedMenuSection {
  group: string
  items: ResolvedMenuItem[]
}

function resolveLabel(item: IMenuItem): string {
  if (item.title) return item.title
  const cmd = CommandsRegistry.getCommand(item.command)
  return cmd?.metadata?.description ?? item.command
}

function resolveShortcut(command: string): string | undefined {
  const all = KeybindingsRegistry.getAllKeybindings()
  for (let i = all.length - 1; i >= 0; i--) {
    const kb = all[i]
    if (kb && kb.command === command && !kb.isNegated) {
      return formatKey(kb.key)
    }
  }
  return undefined
}

function formatKey(key: string): string {
  return key
    .split('+')
    .map((part) => {
      const lower = part.toLowerCase()
      if (lower === 'ctrl') return 'Ctrl'
      if (lower === 'alt') return 'Alt'
      if (lower === 'shift') return 'Shift'
      if (lower === 'meta') return 'Cmd'
      if (lower.length === 1) return lower.toUpperCase()
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join('+')
}

function resolveSections(menuId: MenuId, ctx: IContextKeyService): ResolvedMenuSection[] {
  const items = MenuRegistry.getMenuItems(menuId, ctx)
  const sections: ResolvedMenuSection[] = []
  let current: ResolvedMenuSection | undefined

  for (const item of items) {
    const group = item.group ?? ''
    if (!current || current.group !== group) {
      current = { group, items: [] }
      sections.push(current)
    }
    const resolved: ResolvedMenuItem = {
      command: item.command,
      label: resolveLabel(item),
    }
    const shortcut = resolveShortcut(item.command)
    if (shortcut !== undefined) resolved.shortcut = shortcut
    current.items.push(resolved)
  }
  return sections
}

export function useMenuItems(menuId: MenuId): ResolvedMenuSection[] {
  const contextKeyService = useService(IContextKeyService)
  const cacheRef = useRef<{ menuId: MenuId; resolved: ResolvedMenuSection[] } | null>(null)

  // Recompute synchronously when the menuId argument changes between renders.
  if (cacheRef.current === null || cacheRef.current.menuId !== menuId) {
    cacheRef.current = { menuId, resolved: resolveSections(menuId, contextKeyService) }
  }

  // Refresh cache whenever the context-key service changes identity (e.g. test
  // scaffolding rebuilds the DI container).
  useEffect(() => {
    cacheRef.current = { menuId, resolved: resolveSections(menuId, contextKeyService) }
  }, [menuId, contextKeyService])

  const subscribe = useCallback(
    (onChange: () => void) => {
      const d1 = MenuRegistry.onDidChangeMenu((changed) => {
        if (changed !== menuId) return
        cacheRef.current = { menuId, resolved: resolveSections(menuId, contextKeyService) }
        onChange()
      })
      const d2 = contextKeyService.onDidChangeContext(() => {
        cacheRef.current = { menuId, resolved: resolveSections(menuId, contextKeyService) }
        onChange()
      })
      return () => {
        d1.dispose()
        d2.dispose()
      }
    },
    [menuId, contextKeyService],
  )

  const getSnapshot = useCallback(() => cacheRef.current!.resolved, [])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
