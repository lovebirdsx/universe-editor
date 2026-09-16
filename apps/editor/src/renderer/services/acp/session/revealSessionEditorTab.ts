/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Reveal a session's editor tab, wherever it already lives.
 *
 *  IEditorService.openEditor only dedupes within the *active* group — correct
 *  for files (the same file may legitimately be open in two split groups) but
 *  wrong for a session, which is one chat: with the tab already open in another
 *  group, revealing it opened a second copy in the active group. Callers must
 *  find it across every group first.
 *
 *  Deliberately NOT the rule AcpChatLocationService uses: its
 *  `_isSessionOpenInInactiveGroup` guard must ignore a session sitting in the
 *  ACTIVE group so openEditor re-activates that tab in place.
 *--------------------------------------------------------------------------------------------*/

import {
  IEditorGroupsService,
  IInstantiationService,
  type IEditorGroup,
} from '@universe-editor/platform'
import { AcpSessionEditorInput } from './acpSessionEditorInput.js'

export interface FoundSessionEditor {
  readonly group: IEditorGroup
  readonly editor: AcpSessionEditorInput
}

/** Locate an already-open session editor (and its group) across all groups. */
export function findSessionEditor(
  groups: IEditorGroupsService,
  sessionId: string,
): FoundSessionEditor | undefined {
  for (const group of groups.groups) {
    for (const editor of group.editors) {
      if (editor instanceof AcpSessionEditorInput && editor.sessionId === sessionId) {
        return { group, editor }
      }
    }
  }
  return undefined
}

/**
 * Focus the session's existing tab wherever it lives; only when no tab exists
 * open one, and only for a resident session (`live`). A caller that cannot
 * resolve a live session — e.g. a restored tab whose agent is gone — passes
 * `undefined` and gets reveal-only behaviour.
 */
export function revealSessionEditorTab(
  groups: IEditorGroupsService,
  inst: IInstantiationService,
  sessionId: string,
  live: { agentId: string | undefined } | undefined,
): void {
  const found = findSessionEditor(groups, sessionId)
  if (found) {
    groups.activateGroup(found.group)
    found.group.setActive(found.editor)
    return
  }
  if (!live) return
  const target = groups.activeGroupForOpen
  target.openEditor(
    inst.createInstance(AcpSessionEditorInput, sessionId, live.agentId, undefined),
    { activate: true, pinned: true },
  )
  if (target !== groups.activeGroup) groups.activateGroup(target)
}
