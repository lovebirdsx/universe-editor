/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared opening logic for the rendered previews (markdown / html), so every
 *  entry point behaves the same: Ctrl+Shift+V, a link click inside a preview,
 *  back/forward navigation and the hover "Open Preview" button.
 *
 *  Invariant: a group holds at most one rendered preview tab per kind. Opening
 *  another file's preview retargets the existing one in place (VSCode's dynamic
 *  preview) instead of piling up tabs.
 *
 *  Exceptions — these keep their own tab on purpose:
 *  - `toSide`, which explicitly asks for a second preview alongside the first.
 *  - Reopen Closed Editor and workspace restore, which mean "bring back exactly
 *    this tab" and must respect the user's layout. They open previews directly,
 *    bypassing this module, so a restored group may briefly hold several
 *    previews; the invariant re-establishes itself on the next preview open.
 *
 *  A retargeted preview may hold a source FileEditorInput (toggle mode, see
 *  MarkdownPreviewInput): closing it would cascade-dispose that source and
 *  release the shared Monaco model, silently dropping unsaved edits. So a
 *  *dirty* held source is re-attached as a tab next to the new preview, or — when
 *  the group already shows that file — disposed after handing its dirty flag to
 *  the tab that stays. A clean source loses nothing and goes with the preview.
 *--------------------------------------------------------------------------------------------*/

import type { EditorInput, IEditorGroup } from '@universe-editor/platform'
import type { FileEditorInput } from './FileEditorInput.js'
import { HtmlPreviewInput } from './HtmlPreviewInput.js'
import { MarkdownPreviewInput } from './MarkdownPreviewInput.js'

/** A rendered preview of a source file, opened on demand next to / over it. */
export type SourcePreviewInput = MarkdownPreviewInput | HtmlPreviewInput

/** Same kind of preview — a markdown preview never retargets an html one. */
function isSameKind(
  editor: EditorInput,
  preview: SourcePreviewInput,
): editor is SourcePreviewInput {
  return (
    (editor instanceof MarkdownPreviewInput || editor instanceof HtmlPreviewInput) &&
    editor.typeId === preview.typeId
  )
}

/**
 * The preview tab {@link preview} should take over. Prefers the active editor so
 * navigating between linked previews keeps replacing the tab in front of the
 * user; otherwise the first same-kind preview in the group.
 */
function findRetargetCandidate(
  group: IEditorGroup,
  preview: SourcePreviewInput,
): SourcePreviewInput | undefined {
  const active = group.activeEditor
  if (active && isSameKind(active, preview)) return active
  return group.editors.find((e): e is SourcePreviewInput => isSameKind(e, preview))
}

/** True when the group already shows this exact preview (it was just activated). */
function activateIfOpen(group: IEditorGroup, preview: SourcePreviewInput): boolean {
  const existing = group.findEditor(preview)
  if (!existing) return false
  group.setActive(existing)
  // The caller built `preview` speculatively; dropping it on the floor would
  // leak it (and the source it may hold) as a parentless disposable.
  if (existing !== preview) preview.dispose()
  return true
}

/** Put {@link preview} in {@link old}'s tab slot and close `old`. */
function retargetInPlace(
  group: IEditorGroup,
  preview: SourcePreviewInput,
  old: SourcePreviewInput,
): void {
  const index = group.indexOf(old)
  group.openEditor(preview, { activate: true, pinned: true, index })
  if (old.isDirty) {
    const held = old.releaseSource()
    if (held) {
      // releaseSource() cut `held` loose from `old`'s store — it must end up
      // either owned by the group or disposed here, never parentless.
      const shown = group.findEditor(held)
      if (shown) {
        // The group already shows this file, so the held input would only be a
        // duplicate tab. Hand its dirty flag over first: dirty state is
        // per-input, and the tab that stays resolved its model *after* the edits
        // landed, so it believes the file is clean. Dropping the flag would let
        // it close without the "unsaved changes" prompt and release the shared
        // model with the edits still in it.
        shown.setDirty(true)
        held.dispose()
      } else {
        group.openEditor(held, { activate: false, pinned: true, index: index + 1 })
      }
    }
  }
  group.closeEditor(old)
}

/**
 * Open {@link preview} in {@link group} without touching the source tab — for
 * link clicks, history navigation and hover "Open Preview" buttons. With
 * `toSide` the preview is simply added as another tab.
 */
export function openPreviewInGroup(
  group: IEditorGroup,
  preview: SourcePreviewInput,
  toSide: boolean,
): void {
  if (toSide) {
    group.openEditor(preview, { activate: true, pinned: true })
    return
  }
  if (activateIfOpen(group, preview)) return

  const old = findRetargetCandidate(group, preview)
  if (old) retargetInPlace(group, preview, old)
  else group.openEditor(preview, { activate: true, pinned: true })
}

/**
 * Ctrl+Shift+V: show {@link preview} instead of its {@link source} tab in the
 * same group (no extra tab). The source is detached — not disposed — and held by
 * the preview so its Monaco model survives until the user toggles back.
 *
 * When the group already shows this file's preview, that tab is just activated
 * and the source tab stays put (there is nothing to toggle).
 */
export function togglePreviewInGroup(
  group: IEditorGroup,
  preview: SourcePreviewInput,
  source: FileEditorInput,
): void {
  if (activateIfOpen(group, preview)) return

  const old = findRetargetCandidate(group, preview)
  if (old) retargetInPlace(group, preview, old)
  else group.openEditor(preview, { activate: true, pinned: true, index: group.indexOf(source) })

  group.detachEditor(source)
  // detachEditor cut `source` from the group store without disposing it; the
  // preview now owns its lifecycle.
  preview.adoptSource()
}
