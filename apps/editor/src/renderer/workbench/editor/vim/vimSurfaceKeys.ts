/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Surface keys for Vim mode memory. One (group, input) pair is one editor
 *  surface: the same file shown in two splits has two independent modes, and a
 *  reopened file starts from a fresh key.
 *--------------------------------------------------------------------------------------------*/

export function editorVimSurfaceKey(groupId: number | undefined, inputId: string): string {
  return `editor:${groupId ?? 0}:${inputId}`
}
