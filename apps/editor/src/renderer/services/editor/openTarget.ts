/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Where a user gesture (Enter / click) should open an editor: the active
 *  group, the group to the right, or a new auxiliary window. Ctrl+Cmd share the
 *  side meaning; Alt always wins so Ctrl+Alt+Enter keeps opening a window.
 *--------------------------------------------------------------------------------------------*/

import type { IKeyMods } from '@universe-editor/platform'

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

export interface OpenTargetEnterEvent {
  readonly key: string
  readonly repeat?: boolean
  readonly shiftKey?: boolean
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
  readonly altKey?: boolean
}

/** Modified Enter (Ctrl/Meta/Alt, never Shift) that should open a link/target.
 *  Shift is reserved for chords such as Swarm's Ctrl+Shift+Enter; repeat is
 *  ignored so holding the key doesn't fire the open repeatedly. */
export function isOpenTargetEnter(e: OpenTargetEnterEvent): boolean {
  return (
    e.key === 'Enter' &&
    e.repeat !== true &&
    e.shiftKey !== true &&
    (e.ctrlKey === true || e.metaKey === true || e.altKey === true)
  )
}

/** Quick pick accepts only physical Ctrl (platform `IKeyMods` has no Meta). */
export function resolveQuickPickOpenTarget(mods: IKeyMods | undefined): OpenTarget {
  return resolveOpenTarget(mods === undefined ? undefined : { ctrl: mods.ctrl, alt: mods.alt })
}
