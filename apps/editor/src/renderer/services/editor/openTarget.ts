/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Where a user gesture (Enter / click) should open an editor: the active
 *  group, the group to the right, or a new auxiliary window. Ctrl+Cmd share the
 *  side meaning; Alt always wins so Ctrl+Alt+Enter keeps opening a window.
 *--------------------------------------------------------------------------------------------*/

import { getInvocationModifiers, type IKeyMods } from '@universe-editor/platform'

export { isOpenTargetEnter } from '@universe-editor/platform'

export type OpenTarget = 'default' | 'side' | 'newWindow'

/** The subset that crosses the extension-host boundary; undefined means default. */
export type TargetedOpen = Exclude<OpenTarget, 'default'>

export interface OpenModifiers {
  /** Lower-case spelling used by list/tree activation payloads. */
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly alt?: boolean
  /** DOM-event spelling, so a click/keyboard event can be passed directly. */
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
  readonly altKey?: boolean
}

export function resolveOpenTarget(mods: OpenModifiers | undefined): OpenTarget {
  const alt = mods?.alt === true || mods?.altKey === true
  if (alt) return 'newWindow'
  const ctrl = mods?.ctrl === true || mods?.ctrlKey === true
  const meta = mods?.meta === true || mods?.metaKey === true
  if (ctrl || meta) return 'side'
  return 'default'
}

/** Target of the click that is running the current command (status bar,
 *  toolbar, menu…). Read it before the command's first await. */
export function invocationOpenTarget(): OpenTarget {
  return resolveOpenTarget(getInvocationModifiers())
}

/** Quick pick accepts only physical Ctrl (platform `IKeyMods` has no Meta). */
export function resolveQuickPickOpenTarget(mods: IKeyMods | undefined): OpenTarget {
  return resolveOpenTarget(mods === undefined ? undefined : { ctrl: mods.ctrl, alt: mods.alt })
}
