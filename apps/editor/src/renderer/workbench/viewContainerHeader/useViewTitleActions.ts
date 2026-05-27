/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Subscribes to MenuRegistry + the supplied ContextKey scope and returns
 *  the resolved view-title items in render-ready form (label + icon + command).
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import {
  CommandsRegistry,
  IContextKeyService,
  MenuId,
  MenuRegistry,
  combinedDisposable,
  isSubmenuEntry,
  markAsSingleton,
} from '@universe-editor/platform'
import type { IMenuItem } from '@universe-editor/platform'

export interface ResolvedViewTitleAction {
  command: string
  label: string
  icon?: string
}

function resolveLabel(item: IMenuItem): string {
  if (item.title) return item.title
  const cmd = CommandsRegistry.getCommand(item.command)
  return cmd?.metadata?.description ?? item.command
}

function resolve(menuId: MenuId, ctx: IContextKeyService): ResolvedViewTitleAction[] {
  const items = MenuRegistry.getMenuItems(menuId, ctx)
  const out: ResolvedViewTitleAction[] = []
  for (const item of items) {
    if (isSubmenuEntry(item)) continue
    out.push({
      command: item.command,
      label: resolveLabel(item),
      ...(item.icon !== undefined ? { icon: item.icon } : {}),
    })
  }
  return out
}

export function useViewTitleActions(
  menuId: MenuId,
  ctx: IContextKeyService,
): ResolvedViewTitleAction[] {
  const cacheRef = useRef<ResolvedViewTitleAction[] | null>(null)

  if (cacheRef.current === null) {
    cacheRef.current = resolve(menuId, ctx)
  }

  useEffect(() => {
    cacheRef.current = resolve(menuId, ctx)
  }, [menuId, ctx])

  const subscribe = useCallback(
    (onChange: () => void) => {
      const d1 = MenuRegistry.onDidChangeMenu((changed) => {
        if (changed !== menuId) return
        cacheRef.current = resolve(menuId, ctx)
        onChange()
      })
      const d2 = ctx.onDidChangeContext(() => {
        cacheRef.current = resolve(menuId, ctx)
        onChange()
      })
      const combined = markAsSingleton(combinedDisposable(d1, d2))
      return () => combined.dispose()
    },
    [menuId, ctx],
  )

  const getSnapshot = useCallback(() => cacheRef.current!, [])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
