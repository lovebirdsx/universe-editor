/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  keybindingsEditorRuntime — module-level registry of the live Keyboard
 *  Shortcuts editor instance(s). Action2s (T8) reach the active editor through
 *  getActiveKeybindingsEditor() instead of reaching into the React tree; the
 *  editor component registers its handle on mount and disposes on unmount.
 *  When several instances coexist the most recently registered one wins, and
 *  disposing it falls back to the previous one.
 *--------------------------------------------------------------------------------------------*/

import { toDisposable, type IDisposable } from '@universe-editor/platform'
import type { IKeybindingRow } from './keybindingsEditorModel.js'

export interface IKeybindingsEditorHandle {
  getSelectedRow(): IKeybindingRow | undefined
  defineKeybinding(add: boolean): void
  defineWhenExpression(): void
  toggleRecordKeys(): void
  removeSelectedKeybinding(): void
  resetSelectedKeybinding(): void
  copyEntry(kind: 'json' | 'commandId' | 'commandTitle'): void
  showSameKeybindings(): void
  toggleSortByPrecedence(): void
  clearSearch(): void
  focusSearch(): void
  focusTable(): void
  setQuery(query: string): void
}

const activeHandles: IKeybindingsEditorHandle[] = []

export function registerKeybindingsEditor(handle: IKeybindingsEditorHandle): IDisposable {
  activeHandles.push(handle)
  return toDisposable(() => {
    const index = activeHandles.lastIndexOf(handle)
    if (index !== -1) activeHandles.splice(index, 1)
  })
}

export function getActiveKeybindingsEditor(): IKeybindingsEditorHandle | undefined {
  return activeHandles[activeHandles.length - 1]
}
