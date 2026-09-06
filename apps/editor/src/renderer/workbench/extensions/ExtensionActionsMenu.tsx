/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExtensionActionsMenu — the per-row action menu for an installed extension,
 *  opened by the gear IconButton (left-click) or a right-click on the row. Items
 *  are built dynamically from the entry's enablement state (like
 *  GitGraphContextMenu), not from the MenuRegistry, so enable/disable, the
 *  workspace-scope override, "view details" and uninstall reflect the row.
 *--------------------------------------------------------------------------------------------*/

import { ListMenu, type ListMenuEntry } from '@universe-editor/workbench-ui'
import { localize } from '@universe-editor/platform'
import { renderMenuIcon } from '../icons/menuIcon.js'
import {
  EnablementState,
  type IExtensionEntry,
} from '../../services/extensionsWorkbench/ExtensionsWorkbenchService.js'

export interface ExtensionActionsMenuState {
  readonly x: number
  readonly y: number
  readonly entry: IExtensionEntry
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
    icon: 'eye',
    label: localize('extensions.viewDetails', 'View Details'),
    run: () => h.onOpen(entry),
  }
  const uninstall: ListMenuEntry = {
    kind: 'item',
    icon: 'trash',
    label: localize('extensions.uninstall', 'Uninstall'),
    danger: true,
    run: () => h.onUninstall(entry),
  }
  const set = (state: EnablementState) => () => h.onSetEnablement(entry, state)

  // A dev extension is not in extensions.json — enable/disable and uninstall
  // have no meaning for it. Offer only the details page.
  if (entry.isUnderDevelopment) {
    items.push(viewDetails)
    return items
  }

  // A local-side extension in a remote workspace isn't running, so
  // enable/disable has no effect on it — offer Install-in-Remote + local
  // uninstall instead.
  if (entry.installableInRemote) {
    items.push({
      kind: 'item',
      icon: 'remote',
      label: localize('extensions.installInRemote', 'Install in Remote'),
      run: () => h.onInstallInRemote(entry),
    })
    items.push({ kind: 'separator' })
    items.push(viewDetails)
    items.push({ kind: 'separator' })
    items.push(uninstall)
    return items
  }

  // A version-incompatible extension is auto-disabled by the host — the user
  // cannot enable/disable it, so offer no enablement items (uninstall below
  // stays available for non-built-ins).
  if (!entry.isVersionIncompatible) {
    if (entry.enabled) {
      items.push({
        kind: 'item',
        icon: 'disable',
        label: localize('extensions.disable', 'Disable'),
        run: set(EnablementState.DisabledGlobally),
      })
      if (h.hasWorkspace) {
        items.push({
          kind: 'item',
          icon: 'disable',
          label: localize('extensions.disableWorkspace', 'Disable (Workspace)'),
          run: set(EnablementState.DisabledWorkspace),
        })
      }
    } else {
      items.push({
        kind: 'item',
        icon: 'check',
        label: localize('extensions.enable', 'Enable'),
        run: set(EnablementState.EnabledGlobally),
      })
      if (h.hasWorkspace) {
        items.push({
          kind: 'item',
          icon: 'check',
          label: localize('extensions.enableWorkspace', 'Enable (Workspace)'),
          run: set(EnablementState.EnabledWorkspace),
        })
      }
    }
  }

  items.push({ kind: 'separator' })
  items.push(viewDetails)

  if (!entry.isBuiltin) {
    items.push({ kind: 'separator' })
    items.push(uninstall)
  }

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
  const items = buildItems(state.entry, handlers)
  return (
    <ListMenu
      items={items}
      anchor={{ x: state.x, y: state.y }}
      renderIcon={renderMenuIcon}
      onClose={onClose}
    />
  )
}
