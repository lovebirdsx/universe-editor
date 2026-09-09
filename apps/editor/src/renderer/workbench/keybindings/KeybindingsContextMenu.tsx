/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  KeybindingsContextMenu — right-click menu of the Keyboard Shortcuts table.
 *  Thin wrapper over the workbench-ui ListMenu: the actions operate on the
 *  editor's local selection through the editor handle rather than through global
 *  commands, and each row carries the shortcut that also triggers it — but the
 *  keyboard navigation, virtual focus and opening highlight are the shared ones.
 *--------------------------------------------------------------------------------------------*/

import { useMemo } from 'react'
import { localize } from '@universe-editor/platform'
import { ListMenu, type ListMenuEntry } from '@universe-editor/workbench-ui'
import { renderMenuIcon } from '../icons/menuIcon.js'
import { useContextMenuMemory } from '../contextMenu/useContextMenuMemory.js'
import type { IKeybindingRow } from '../../services/keybindings/keybindingsEditorModel.js'
import type { IKeybindingsEditorHandle } from '../../services/keybindings/keybindingsEditorRuntime.js'

const SEPARATOR: ListMenuEntry = { kind: 'separator' }

function action(
  id: string,
  label: string,
  icon: string,
  hint: string | undefined,
  enabled: boolean,
  run: () => void,
): ListMenuEntry {
  return { kind: 'item', id, label, icon, hint, disabled: !enabled, run }
}

export interface KeybindingsContextMenuProps {
  readonly x: number
  readonly y: number
  readonly row: IKeybindingRow
  readonly handle: IKeybindingsEditorHandle
  /** Raised with the ContextMenu key, so it opens with the first entry highlighted. */
  readonly keyboard: boolean
  readonly onClose: () => void
}

export function KeybindingsContextMenu({
  x,
  y,
  row,
  handle,
  keyboard,
  onClose,
}: KeybindingsContextMenuProps) {
  const memory = useContextMenuMemory()
  const entries = useMemo<readonly ListMenuEntry[]>(() => {
    const hasBinding = row.keybinding !== undefined
    const isUser = row.source.kind === 'user'
    const hasTitle = row.commandLabel !== row.command

    return [
      action('copy', localize('keybindings.menu.copy', 'Copy'), 'copy', 'Ctrl+C', true, () =>
        handle.copyEntry('json'),
      ),
      action(
        'copyCommandId',
        localize('keybindings.menu.copyCommandId', 'Copy Command ID'),
        'copy',
        undefined,
        true,
        () => handle.copyEntry('commandId'),
      ),
      action(
        'copyCommandTitle',
        localize('keybindings.menu.copyCommandTitle', 'Copy Command Title'),
        'copy',
        undefined,
        hasTitle,
        () => handle.copyEntry('commandTitle'),
      ),
      SEPARATOR,
      hasBinding
        ? action(
            'changeKeybinding',
            localize('keybindings.menu.changeKeybinding', 'Change Keybinding...'),
            'keyboard',
            'Enter',
            true,
            () => handle.defineKeybinding(false),
          )
        : action(
            'addKeybinding',
            localize('keybindings.menu.addKeybinding', 'Add Keybinding...'),
            'keyboard',
            'Ctrl+K Ctrl+A',
            true,
            () => handle.defineKeybinding(false),
          ),
      SEPARATOR,
      action(
        'removeKeybinding',
        localize('keybindings.menu.removeKeybinding', 'Remove Keybinding'),
        'remove',
        'Delete',
        hasBinding,
        () => handle.removeSelectedKeybinding(),
      ),
      action(
        'resetKeybinding',
        localize('keybindings.menu.resetKeybinding', 'Reset Keybinding'),
        'reset',
        undefined,
        isUser,
        () => handle.resetSelectedKeybinding(),
      ),
      SEPARATOR,
      action(
        'changeWhen',
        localize('keybindings.menu.changeWhen', 'Change When Expression'),
        'when',
        'Ctrl+K Ctrl+E',
        hasBinding,
        () => handle.defineWhenExpression(),
      ),
      SEPARATOR,
      action(
        'showSame',
        localize('keybindings.menu.showSame', 'Show Same Keybindings'),
        'list-view',
        undefined,
        hasBinding,
        () => handle.showSameKeybindings(),
      ),
    ]
  }, [row, handle])

  return (
    <ListMenu
      items={entries}
      anchor={{ x, y }}
      autoFocusFirst={keyboard}
      {...(memory ? { memory } : {})}
      memoryKey="keybindings"
      renderIcon={renderMenuIcon}
      onClose={onClose}
    />
  )
}
