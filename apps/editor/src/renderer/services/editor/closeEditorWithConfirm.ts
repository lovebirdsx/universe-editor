/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  closeEditorWithConfirm — single source of truth for closing an editor that
 *  may be dirty. Used by tab × buttons, Ctrl+W, and Close All paths.
 *--------------------------------------------------------------------------------------------*/

import {
  localize,
  type EditorInput,
  type IDialogService,
  type IEditorGroup,
} from '@universe-editor/platform'

/**
 * Returns `true` when the editor was closed (either was clean, saved, or
 * discarded). Returns `false` when the user cancelled the confirm prompt.
 */
export async function closeEditorWithConfirm(
  input: EditorInput,
  group: IEditorGroup,
  dialogService: IDialogService,
): Promise<boolean> {
  if (input.confirmClose) {
    const ok = await input.confirmClose(dialogService)
    if (!ok) return false
    group.closeEditor(input)
    return true
  }

  if (!input.isDirty) {
    group.closeEditor(input)
    return true
  }

  const result = await dialogService.confirm({
    message: localize(
      'dialog.closeEditor.message',
      'Do you want to save the changes you made to {label}?',
      {
        label: input.label,
      },
    ),
    detail: localize(
      'dialog.closeEditor.detail',
      "Your changes will be lost if you don't save them.",
    ),
    primaryButton: localize('common.save', 'Save'),
    secondaryButton: localize('dialog.closeEditor.dontSave', "Don't Save"),
    cancelButton: localize('common.cancel', 'Cancel'),
    type: 'warning',
  })

  if (result.choice === 'cancel') return false

  if (result.choice === 'primary') {
    const ok = (await input.save?.()) ?? true
    if (!ok) return false
  }

  group.closeEditor(input)
  return true
}
