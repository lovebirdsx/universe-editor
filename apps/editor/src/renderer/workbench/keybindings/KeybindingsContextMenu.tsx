/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  KeybindingsContextMenu — right-click menu of the Keyboard Shortcuts table.
 *  Bespoke AnchoredSurface menu (same pattern as SearchResultsContextMenu):
 *  the actions operate on the editor's local selection through the editor
 *  handle rather than through global commands.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import { AnchoredSurface, cx } from '@universe-editor/workbench-ui'
import type { IKeybindingRow } from '../../services/keybindings/keybindingsEditorModel.js'
import type { IKeybindingsEditorHandle } from '../../services/keybindings/keybindingsEditorRuntime.js'
import styles from './KeybindingsContextMenu.module.css'

interface IMenuAction {
  readonly kind: 'action'
  readonly label: string
  readonly hint: string | undefined
  readonly enabled: boolean
  readonly run: () => void
}

interface IMenuSeparator {
  readonly kind: 'separator'
}

type MenuEntry = IMenuAction | IMenuSeparator

const SEPARATOR: IMenuSeparator = { kind: 'separator' }

function action(
  label: string,
  hint: string | undefined,
  enabled: boolean,
  run: () => void,
): IMenuAction {
  return { kind: 'action', label, hint, enabled, run }
}

export interface KeybindingsContextMenuProps {
  readonly x: number
  readonly y: number
  readonly row: IKeybindingRow
  readonly handle: IKeybindingsEditorHandle
  readonly onClose: () => void
}

export function KeybindingsContextMenu({
  x,
  y,
  row,
  handle,
  onClose,
}: KeybindingsContextMenuProps) {
  const hasBinding = row.keybinding !== undefined
  const isUser = row.source.kind === 'user'
  const hasTitle = row.commandLabel !== row.command

  const entries: MenuEntry[] = [
    action(localize('keybindings.menu.copy', 'Copy'), 'Ctrl+C', true, () =>
      handle.copyEntry('json'),
    ),
    action(localize('keybindings.menu.copyCommandId', 'Copy Command ID'), undefined, true, () =>
      handle.copyEntry('commandId'),
    ),
    action(
      localize('keybindings.menu.copyCommandTitle', 'Copy Command Title'),
      undefined,
      hasTitle,
      () => handle.copyEntry('commandTitle'),
    ),
    SEPARATOR,
    hasBinding
      ? action(
          localize('keybindings.menu.changeKeybinding', 'Change Keybinding...'),
          'Enter',
          true,
          () => handle.defineKeybinding(false),
        )
      : action(
          localize('keybindings.menu.addKeybinding', 'Add Keybinding...'),
          'Ctrl+K Ctrl+A',
          true,
          () => handle.defineKeybinding(false),
        ),
    SEPARATOR,
    action(
      localize('keybindings.menu.removeKeybinding', 'Remove Keybinding'),
      'Delete',
      hasBinding,
      () => handle.removeSelectedKeybinding(),
    ),
    action(
      localize('keybindings.menu.resetKeybinding', 'Reset Keybinding'),
      undefined,
      isUser,
      () => handle.resetSelectedKeybinding(),
    ),
    SEPARATOR,
    action(
      localize('keybindings.menu.changeWhen', 'Change When Expression'),
      'Ctrl+K Ctrl+E',
      hasBinding,
      () => handle.defineWhenExpression(),
    ),
    SEPARATOR,
    action(
      localize('keybindings.menu.showSame', 'Show Same Keybindings'),
      undefined,
      hasBinding,
      () => handle.showSameKeybindings(),
    ),
  ]

  return (
    <AnchoredSurface x={x} y={y} onClose={onClose}>
      <ul role="menu" className={styles['menu']}>
        {entries.map((entry, index) =>
          entry.kind === 'separator' ? (
            <li key={`sep-${index}`} role="separator" className={styles['separator']} />
          ) : (
            <li
              key={entry.label}
              role="menuitem"
              tabIndex={-1}
              aria-disabled={!entry.enabled}
              className={cx(styles['item'], !entry.enabled && styles['disabled'])}
              onClick={() => {
                if (!entry.enabled) return
                onClose()
                entry.run()
              }}
            >
              <span>{entry.label}</span>
              {entry.hint !== undefined && <span className={styles['hint']}>{entry.hint}</span>}
            </li>
          ),
        )}
      </ul>
    </AnchoredSurface>
  )
}
