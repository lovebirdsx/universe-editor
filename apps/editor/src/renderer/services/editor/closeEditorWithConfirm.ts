/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  closeEditorWithConfirm — single source of truth for closing an editor that
 *  may be dirty. Used by tab × buttons, Ctrl+W, and Close All paths.
 *--------------------------------------------------------------------------------------------*/

import type { EditorInput, IDialogService, IEditorGroup } from '@universe-editor/platform'

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
    message: `Do you want to save the changes you made to ${input.label}?`,
    detail: "Your changes will be lost if you don't save them.",
    primaryButton: 'Save',
    secondaryButton: "Don't Save",
    cancelButton: 'Cancel',
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
