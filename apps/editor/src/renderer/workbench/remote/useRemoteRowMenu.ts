/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useRemoteRowMenu — per-view state holder for the Remote Explorer row
 *  context menu: captures the click anchor + per-row payload and hands the
 *  view a `menu` state to render via <RemoteContextMenu>.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useState, type MouseEvent } from 'react'
import type { RemoteMenuState } from './RemoteContextMenu.js'

export function useRemoteRowMenu(): {
  readonly menu: RemoteMenuState | null
  readonly openMenu: (target: RemoteMenuState['target']) => (e: MouseEvent<HTMLDivElement>) => void
  readonly closeMenu: () => void
} {
  const [menu, setMenu] = useState<RemoteMenuState | null>(null)
  const openMenu = useCallback(
    (target: RemoteMenuState['target']) => (e: MouseEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.stopPropagation()
      setMenu({ x: e.clientX, y: e.clientY, target })
    },
    [],
  )
  const closeMenu = useCallback(() => setMenu(null), [])
  return { menu, openMenu, closeMenu }
}
