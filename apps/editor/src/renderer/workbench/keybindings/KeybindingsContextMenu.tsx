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
import type { IKeybindingRow } from '../../services/keybindings/keybindingsEditorModel.js'
import type { IKeybindingsEditorHandle } from '../../services/keybindings/keybindingsEditorRuntime.js'

const SEPARATOR: ListMenuEntry = { kind: 'separator' }

function action(
  label: string,
  hint: string | undefined,
  enabled: boolean,
  run: () => void,
): ListMenuEntry {
  return { kind: 'item', label, hint, disabled: !enabled, run }
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
  const entries = useMemo<readonly ListMenuEntry[]>(() => {
    const hasBinding = row.keybinding !== undefined
    const isUser = row.source.kind === 'user'
    const hasTitle = row.commandLabel !== row.command

    return [
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
  }, [row, handle])

  return <ListMenu items={entries} anchor={{ x, y }} autoFocusFirst={keyboard} onClose={onClose} />
}
