/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared doc-center opening logic so clicking a link in a built-in guide and
 *  back/forward navigation behave identically. Plain navigation replaces the
 *  current doc tab in place (so the trail stays a single tab, mirroring the
 *  markdown preview); `toSide` opens an additional doc tab in the group.
 *--------------------------------------------------------------------------------------------*/

import type { IEditorGroup } from '@universe-editor/platform'
import { DocEditorInput } from './DocEditorInput.js'
import { ensureSideGroup } from './openToSide.js'
import type { OpenTarget } from './openTarget.js'
import {
  findEditorById,
  openExistingInputWithTarget,
  openFreshInputWithTarget,
  type OpenTargetServices,
  type TargetedOpenResult,
} from './openWithTarget.js'

/**
 * Open {@link doc} in {@link group}. When the active editor is another doc and
 * `toSide` is false, the new doc takes its tab slot and the old one is closed —
 * so navigating between linked docs reuses one tab and H/L (or Alt+←/→) walks
 * the trail without piling up tabs. `openEditor` dedups by id, so a target
 * already open in the group is reused and activated instead.
 */
export function openDocInGroup(group: IEditorGroup, doc: DocEditorInput, toSide: boolean): void {
  if (!toSide) {
    const current = group.activeEditor
    if (current instanceof DocEditorInput && current.id !== doc.id) {
      const index = group.indexOf(current)
      group.openEditor(doc, { activate: true, pinned: true, index })
      group.closeEditor(current)
      return
    }
  }
  group.openEditor(doc, { activate: true, pinned: true })
}

/**
 * Target-aware doc navigation for side/new-window opens. Default (in-place)
 * navigation stays with {@link openDocInGroup}: replacing the current tab is
 * only meaningful for the group the link was clicked in.
 */
export async function openDocWithTarget(
  targets: OpenTargetServices,
  doc: DocEditorInput,
  target: Exclude<OpenTarget, 'default'>,
  sourceGroup?: IEditorGroup,
): Promise<TargetedOpenResult> {
  if (target === 'side') {
    const side = ensureSideGroup(targets.groups, sourceGroup)
    const dest = side.isLocked ? targets.groups.activeGroupForOpen : side
    openDocInGroup(dest, doc, true)
    return { handled: true, editor: doc, group: dest }
  }
  const existing = findEditorById(targets.groups, doc.id)
  if (existing) {
    // The caller built this instance for the new-window attempt; the copy/move
    // uses the mounted one instead, so the unused instance must not linger.
    if (!doc.isDisposed) doc.dispose()
    return openExistingInputWithTarget(targets, existing.editor, existing.group, target, {
      pinned: true,
    })
  }
  return openFreshInputWithTarget(targets, doc, target, { pinned: true })
}
