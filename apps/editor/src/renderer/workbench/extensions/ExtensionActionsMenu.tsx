/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExtensionActionsMenu — the per-row action menu for an installed extension,
 *  opened by the gear IconButton (left-click) or a right-click on the row. Items
 *  are built dynamically from the entry's enablement state (like
 *  GitGraphContextMenu), not from the MenuRegistry, so enable/disable, the
 *  workspace-scope override, "view details" and uninstall reflect the row.
 *
 *  Rendering goes through the shared `ListMenu`, so the menu gets the same
 *  keyboard navigation and virtual focus as every other item-driven menu in the
 *  workbench rather than a second, hand-rolled one.
 *--------------------------------------------------------------------------------------------*/

import { ListMenu, type ListMenuEntry } from '@universe-editor/workbench-ui'
import { localize } from '@universe-editor/platform'
import { renderMenuIcon } from '../icons/menuIcon.js'
import { useContextMenuMemory } from '../contextMenu/useContextMenuMemory.js'
import {
  EnablementState,
  type IExtensionEntry,
} from '../../services/extensionsWorkbench/ExtensionsWorkbenchService.js'

export interface ExtensionActionsMenuState {
  readonly x: number
  readonly y: number
  readonly entry: IExtensionEntry
  /**
   * Raised by the ContextMenu key / Shift+F10 — open with the first row
   * highlighted, since a keyboard user has no pointer to aim.
   */
  readonly keyboard?: boolean
}

export interface ExtensionActionsMenuHandlers {
  readonly onOpen: (entry: IExtensionEntry) => void
  readonly onUninstall: (entry: IExtensionEntry) => void
  readonly onSetEnablement: (entry: IExtensionEntry, state: EnablementState) => void
  readonly onInstallInRemote: (entry: IExtensionEntry) => void
  readonly hasWorkspace: boolean
}

function buildItems(entry: IExtensionEntry, h: ExtensionActionsMenuHandlers): ListMenuEntry[] {
  const items: ListMenuEntry[] = []
  const viewDetails: ListMenuEntry = {
    kind: 'item',
    id: 'viewDetails',
    icon: 'eye',
    label: localize('extensions.viewDetails', 'View Details'),
    run: () => h.onOpen(entry),
  }
  const uninstall: ListMenuEntry = {
    kind: 'item',
    id: 'uninstall',
    icon: 'trash',
    label: localize('extensions.uninstall', 'Uninstall'),
    danger: true,
    run: () => h.onUninstall(entry),
  }

  // A dev extension is not in extensions.json — enable/disable and uninstall
  // have no meaning for it. Offer only the details page.
  if (entry.isUnderDevelopment) return [viewDetails]

  // A local-side extension in a remote workspace isn't running, so
  // enable/disable has no effect on it — offer Install-in-Remote + local
  // uninstall instead.
  if (entry.installableInRemote) {
    return [
      {
        kind: 'item',
        id: 'installInRemote',
        icon: 'remote',
        label: localize('extensions.installInRemote', 'Install in Remote'),
        run: () => h.onInstallInRemote(entry),
      },
      { kind: 'separator' },
      viewDetails,
      { kind: 'separator' },
      uninstall,
    ]
  }

  // A version-incompatible extension is auto-disabled by the host — the user
  // cannot enable/disable it, so offer no enablement items (uninstall below
  // stays available for non-built-ins).
  if (!entry.isVersionIncompatible) {
    const set = (state: EnablementState) => () => h.onSetEnablement(entry, state)
    if (entry.enabled) {
      items.push({
        kind: 'item',
        id: 'disable',
        icon: 'disable',
        label: localize('extensions.disable', 'Disable'),
        run: set(EnablementState.DisabledGlobally),
      })
      if (h.hasWorkspace) {
        items.push({
          kind: 'item',
          id: 'disableWorkspace',
          icon: 'disable',
          label: localize('extensions.disableWorkspace', 'Disable (Workspace)'),
          run: set(EnablementState.DisabledWorkspace),
        })
      }
    } else {
      items.push({
        kind: 'item',
        id: 'enable',
        icon: 'check',
        label: localize('extensions.enable', 'Enable'),
        run: set(EnablementState.EnabledGlobally),
      })
      if (h.hasWorkspace) {
        items.push({
          kind: 'item',
          id: 'enableWorkspace',
          icon: 'check',
          label: localize('extensions.enableWorkspace', 'Enable (Workspace)'),
          run: set(EnablementState.EnabledWorkspace),
        })
      }
    }
  }

  items.push({ kind: 'separator' }, viewDetails)
  if (!entry.isBuiltin) items.push({ kind: 'separator' }, uninstall)

  return items
}

export function ExtensionActionsMenu({
  state,
  handlers,
  onClose,
}: {
  state: ExtensionActionsMenuState
  handlers: ExtensionActionsMenuHandlers
  onClose: () => void
}) {
  const memory = useContextMenuMemory()

  return (
    <ListMenu
      items={buildItems(state.entry, handlers)}
      anchor={{ x: state.x, y: state.y }}
      renderIcon={renderMenuIcon}
      autoFocusFirst={state.keyboard === true}
      {...(memory ? { memory } : {})}
      memoryKey="extensions.actions"
      onClose={onClose}
    />
  )
}
