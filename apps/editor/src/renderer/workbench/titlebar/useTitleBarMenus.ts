/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Hook that subscribes to MenuRegistry and resolves menu items into UI-ready
 *  sections (grouped, with label + shortcut filled in).
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import {
  CommandsRegistry,
  IContextKeyService,
  MenuRegistry,
  combinedDisposable,
  isSubmenuEntry,
  markAsSingleton,
} from '@universe-editor/platform'
import type { IMenuItem, ISubmenuItem, MenuId } from '@universe-editor/platform'
import { useService } from '../useService.js'
import { resolveShortcut } from './keybindingFormat.js'

export interface ResolvedCommandItem {
  kind: 'command'
  command: string
  label: string
  shortcut?: string
  icon?: string
}

export interface ResolvedSubmenuItem {
  kind: 'submenu'
  submenu: MenuId
  label: string
  icon?: string
}

export type ResolvedMenuEntry = ResolvedCommandItem | ResolvedSubmenuItem

export interface ResolvedMenuSection {
  group: string
  items: ResolvedMenuEntry[]
}

function resolveLabel(item: IMenuItem): string {
  if (item.title) return item.title
  const cmd = CommandsRegistry.getCommand(item.command)
  return cmd?.metadata?.description ?? item.command
}

function resolveSubmenuEntry(entry: ISubmenuItem): ResolvedSubmenuItem {
  return {
    kind: 'submenu',
    submenu: entry.submenu,
    label: entry.title,
    ...(entry.icon !== undefined ? { icon: entry.icon } : {}),
  }
}

function resolveCommandEntry(entry: IMenuItem): ResolvedCommandItem {
  const resolved: ResolvedCommandItem = {
    kind: 'command',
    command: entry.command,
    label: resolveLabel(entry),
    ...(entry.icon !== undefined ? { icon: entry.icon } : {}),
  }
  const shortcut = resolveShortcut(entry.command)
  if (shortcut !== undefined) resolved.shortcut = shortcut
  return resolved
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
    current.items.push(isSubmenuEntry(item) ? resolveSubmenuEntry(item) : resolveCommandEntry(item))
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

  useEffect(() => {
    cacheRef.current = { menuId, resolved: resolveSections(menuId, contextKeyService) }
  }, [menuId, contextKeyService])

  const subscribe = useCallback(
    (onChange: () => void) => {
      // Submenu entries may reference other MenuIds, so we listen for any
      // change to invalidate this hook's cache. The set of MenuIds rendered
      // in nested popovers is small, and resolveSections is cheap.
      const d1 = MenuRegistry.onDidChangeMenu(() => {
        cacheRef.current = { menuId, resolved: resolveSections(menuId, contextKeyService) }
        onChange()
      })
      const d2 = contextKeyService.onDidChangeContext(() => {
        cacheRef.current = { menuId, resolved: resolveSections(menuId, contextKeyService) }
        onChange()
      })
      // React owns lifecycle via useSyncExternalStore — these are disposed on
      // unmount. Mark as singleton so beforeunload (which fires before React
      // teardown on page reload) doesn't report them as leaks.
      const combined = markAsSingleton(combinedDisposable(d1, d2))
      return () => combined.dispose()
    },
    [menuId, contextKeyService],
  )

  const getSnapshot = useCallback(() => cacheRef.current!.resolved, [])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
