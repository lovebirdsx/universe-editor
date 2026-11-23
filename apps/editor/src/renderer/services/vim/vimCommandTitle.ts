/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Display title of a command id for Vim's discovery UIs (which-key, cheat sheet).
 *  Registered Action2 commands carry their localized title in `metadata.description`;
 *  Monaco editor actions (`editor.action.*`) are not in the registry, so they fall back
 *  to a humanized id instead of showing nothing.
 *--------------------------------------------------------------------------------------------*/

import { CommandsRegistry } from '@universe-editor/platform'

/** `editor.action.goToReferences` → `Go To References`. */
export function humanizeCommandId(id: string): string {
  const last = id.split('.').pop() ?? id
  const spaced = last.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export function resolveVimCommandTitle(id: string): string {
  const description = CommandsRegistry.getCommand(id)?.metadata?.description
  return description !== undefined && description.length > 0 ? description : humanizeCommandId(id)
}
