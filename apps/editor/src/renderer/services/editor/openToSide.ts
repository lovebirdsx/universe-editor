/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ensureSideGroup — the group an "open to the side" lands in: the nearest group
 *  to the right of `source`, created when the layout has none, and activated so
 *  the opened editor is what the user sees.
 *
 *  Activating is load-bearing, not cosmetic: IEditorResolverService and
 *  IEditorService both route a *new* editor through `activeGroupForOpen`, which
 *  follows the active group — so a call site that opens through the resolver
 *  lands in the side group only because this ran first. (A locked target is
 *  still routed away by `activeGroupForOpen`, which is the lock doing its job.)
 *
 *  Call this at the open site itself, never before an `await`: the fresh group
 *  is not reclaimed if the click ends up opening nothing (reclaim only fires on
 *  a group-model change, and an empty group that was only activated never
 *  changes one), so hoisting the call leaves orphan groups behind for every
 *  "file not found", "several matches" or "target is a directory" outcome.
 *--------------------------------------------------------------------------------------------*/

import {
  GroupDirection,
  type IEditorGroup,
  type IEditorGroupsService,
} from '@universe-editor/platform'

/** The group to the right of {@link source} (default: the active group), created
 *  and activated when absent. Returns the target group. */
export function ensureSideGroup(
  groups: IEditorGroupsService,
  source: IEditorGroup = groups.activeGroup,
): IEditorGroup {
  let target = groups.findGroup({ direction: GroupDirection.Right }, source) ?? source
  if (target === source) target = groups.addGroup(source, GroupDirection.Right)
  groups.activateGroup(target)
  return target
}
