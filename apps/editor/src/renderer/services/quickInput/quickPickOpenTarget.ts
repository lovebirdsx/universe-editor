/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Product mapping for the modifier state captured by a quick pick accept:
 *  Ctrl+Enter opens to the side, Alt+Enter opens in a new auxiliary editor
 *  window. Alt wins over Ctrl so Ctrl+Alt+Enter keeps the new-window meaning.
 *--------------------------------------------------------------------------------------------*/

import type { IKeyMods } from '@universe-editor/platform'

export type QuickPickOpenTarget = 'default' | 'side' | 'newWindow'

export function resolveQuickPickOpenTarget(mods: IKeyMods | undefined): QuickPickOpenTarget {
  if (mods !== undefined && mods.alt) return 'newWindow'
  if (mods !== undefined && mods.ctrl) return 'side'
  return 'default'
}
