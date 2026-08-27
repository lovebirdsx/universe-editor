/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared opening logic for the rendered previews (markdown / html), so every
 *  entry point behaves the same: Ctrl+Shift+V, a link click inside a preview,
 *  back/forward navigation and the hover "Open Preview" button.
 *
 *  Invariants:
 *  - A preview of a given file is globally unique: opening it while any group
 *    already shows that preview focuses the existing tab instead of opening a
 *    second one.
 *  - Previews of *different* files may coexist in the same group.
 *  - A toggle preview inherits the source tab's pin state: a preview-slot
 *    source yields a preview in the slot, a pinned source a pinned preview.
 *
 *  Exception — workspace restore means "bring back exactly this tab" and must
 *  respect the user's layout, so it opens previews directly and a restored
 *  group may briefly hold duplicate previews; the uniqueness invariant
 *  re-establishes itself on the next preview open.
 *--------------------------------------------------------------------------------------------*/

import type { EditorInput, IEditorGroup, IEditorGroupsService } from '@universe-editor/platform'
import type { FileEditorInput } from './FileEditorInput.js'
import { HtmlPreviewInput } from './HtmlPreviewInput.js'
import { MarkdownPreviewInput } from './MarkdownPreviewInput.js'

/** A rendered preview of a source file, opened on demand next to / over it. */
export type SourcePreviewInput = MarkdownPreviewInput | HtmlPreviewInput

/**
 * The tab showing this exact preview, if any — {@link targetGroup} first, then
 * the other groups. `findEditor` matches by input id (`markdown-preview:<uri>` /
 * `html-preview:<uri>`), which naturally isolates the two kinds.
 */
function findExistingPreview(
  groups: IEditorGroupsService,
  targetGroup: IEditorGroup,
  preview: SourcePreviewInput,
): { group: IEditorGroup; editor: EditorInput } | undefined {
  const found = targetGroup.findEditor(preview)
  if (found) return { group: targetGroup, editor: found }
  for (const g of groups.getGroups()) {
    if (g === targetGroup) continue
    const editor = g.findEditor(preview)
    if (editor) return { group: g, editor }
  }
  return undefined
}

function focusExistingPreview(
  groups: IEditorGroupsService,
  found: { group: IEditorGroup; editor: EditorInput },
  preview: SourcePreviewInput,
): void {
  groups.activateGroup(found.group)
  found.group.setActive(found.editor)
  // The caller built `preview` speculatively; dropping it on the floor would
  // leak it (and the source it may hold) as a parentless disposable. A toggle-
  // built instance has not called adoptSource yet, so disposing it cannot
  // cascade to its source input.
  if (found.editor !== preview) preview.dispose()
}

/**
 * Open {@link preview} in {@link group} without touching the source tab — for
 * link clicks, history navigation and hover "Open Preview" buttons. A preview
 * of the same file already open in another group is focused instead. Pinned by
 * default; pass `pinned: false` to land in the group's preview slot.
 */
export function openPreviewInGroup(
  groups: IEditorGroupsService,
  group: IEditorGroup,
  preview: SourcePreviewInput,
  opts?: { pinned?: boolean; index?: number },
): void {
  const existing = findExistingPreview(groups, group, preview)
  if (existing) {
    focusExistingPreview(groups, existing, preview)
    return
  }
  group.openEditor(preview, {
    activate: true,
    pinned: opts?.pinned ?? true,
    ...(opts?.index !== undefined ? { index: opts.index } : {}),
  })
  // Surface the tab the command just opened: a lock-routed or reopen-target
  // group may not be the active one, and without this the preview would land
  // in a background group, invisible.
  if (group !== groups.activeGroup) groups.activateGroup(group)
}

/**
 * Ctrl+Shift+V: show {@link preview} instead of its {@link source} tab in the
 * same group (no extra tab). The source is detached — not disposed — and held by
 * the preview so its Monaco model survives until the user toggles back.
 *
 * When a group already shows this file's preview, that tab is just activated
 * and the source tab stays put (there is nothing to toggle).
 */
export function togglePreviewInGroup(
  groups: IEditorGroupsService,
  group: IEditorGroup,
  preview: SourcePreviewInput,
  source: FileEditorInput,
): void {
  const existing = findExistingPreview(groups, group, preview)
  if (existing) {
    focusExistingPreview(groups, existing, preview)
    return
  }

  // Read both flags *before* detaching: once detached the source is no longer
  // in the group, so isPinned cannot answer for it (it reports false for
  // unknown editors). A dirty source must never land in the slot — a later
  // previewReplace would cascade-dispose it and drop the edits.
  const pinned = group.isPinned(source) || source.isDirty
  const index = group.indexOf(source)

  // Detach first: with the source still occupying the slot, a pinned:false
  // open would hit the previewReplace branch and dispose the source in place
  // (edits lost). Detaching clears the model's _previewEditor, so the open
  // takes the slot through the normal insert branch.
  group.detachEditor(source)
  group.openEditor(preview, { activate: true, pinned, index })
  // detachEditor cut `source` from the group store without disposing it; the
  // preview now owns its lifecycle.
  preview.adoptSource()
}
