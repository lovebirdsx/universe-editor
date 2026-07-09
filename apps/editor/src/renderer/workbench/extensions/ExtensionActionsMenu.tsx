/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExtensionActionsMenu — the per-row action menu for an installed extension,
 *  opened by the gear IconButton (left-click) or a right-click on the row. Items
 *  are built dynamically from the entry's enablement state (like
 *  GitGraphContextMenu), not from the MenuRegistry, so enable/disable, the
 *  workspace-scope override, "view details" and uninstall reflect the row.
 *--------------------------------------------------------------------------------------------*/

import { AnchoredSurface } from '@universe-editor/workbench-ui'
import { localize } from '@universe-editor/platform'
import {
  EnablementState,
  type IExtensionEntry,
} from '../../services/extensionsWorkbench/ExtensionsWorkbenchService.js'
import styles from './ExtensionsView.module.css'

type MenuItem =
  | {
      readonly kind: 'item'
      readonly label: string
      readonly danger?: boolean
      readonly run: () => void
    }
  | { readonly kind: 'sep' }

export interface ExtensionActionsMenuState {
  readonly x: number
  readonly y: number
  readonly entry: IExtensionEntry
}

export interface ExtensionActionsMenuHandlers {
  readonly onOpen: (entry: IExtensionEntry) => void
  readonly onUninstall: (entry: IExtensionEntry) => void
  readonly onSetEnablement: (entry: IExtensionEntry, state: EnablementState) => void
  readonly hasWorkspace: boolean
}

function buildItems(
  entry: IExtensionEntry,
  h: ExtensionActionsMenuHandlers,
  close: () => void,
): MenuItem[] {
  const items: MenuItem[] = []
  const set = (state: EnablementState) => () => {
    close()
    h.onSetEnablement(entry, state)
  }

  if (entry.enabled) {
    items.push({
      kind: 'item',
      label: localize('extensions.disable', 'Disable'),
      run: set(EnablementState.DisabledGlobally),
    })
    if (h.hasWorkspace) {
      items.push({
        kind: 'item',
        label: localize('extensions.disableWorkspace', 'Disable (Workspace)'),
        run: set(EnablementState.DisabledWorkspace),
      })
    }
  } else {
    items.push({
      kind: 'item',
      label: localize('extensions.enable', 'Enable'),
      run: set(EnablementState.EnabledGlobally),
    })
    if (h.hasWorkspace) {
      items.push({
        kind: 'item',
        label: localize('extensions.enableWorkspace', 'Enable (Workspace)'),
        run: set(EnablementState.EnabledWorkspace),
      })
    }
  }

  items.push({ kind: 'sep' })
  items.push({
    kind: 'item',
    label: localize('extensions.viewDetails', 'View Details'),
    run: () => {
      close()
      h.onOpen(entry)
    },
  })

  if (!entry.isBuiltin) {
    items.push({ kind: 'sep' })
    items.push({
      kind: 'item',
      label: localize('extensions.uninstall', 'Uninstall'),
      danger: true,
      run: () => {
        close()
        h.onUninstall(entry)
      },
    })
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
  const items = buildItems(state.entry, handlers, onClose)
  return (
    <AnchoredSurface x={state.x} y={state.y} onClose={onClose}>
      <ul role="menu" className={styles.menu}>
        {items.map((item, i) =>
          item.kind === 'sep' ? (
            <li key={`sep-${i}`} role="separator" className={styles.menuSep} />
          ) : (
            <li
              key={`${item.label}-${i}`}
              role="menuitem"
              className={
                item.danger ? `${styles.menuItem} ${styles.menuItemDanger}` : styles.menuItem
              }
              onClick={item.run}
            >
              {item.label}
            </li>
          ),
        )}
      </ul>
    </AnchoredSurface>
  )
}
