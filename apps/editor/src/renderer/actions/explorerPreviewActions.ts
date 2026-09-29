/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Explorer row actions — the right-click "Open Preview" entry for markdown / html
 *  files, the twin of the row's hover eye button (ResourcePreviewButton).
 *
 *  The editor-state preview commands (`workbench.action.markdown.openPreview` and
 *  its html sibling) gate on `activeEditorLanguageId` and act on the active
 *  editor, so they cannot serve a resource the user right-clicked without
 *  opening. This one takes the resource as its argument instead.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorGroupsService,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { openResourcePreviewInGroup } from '../services/resourcePreview/openResourcePreview.js'
import { resolvePrimaryTarget } from './fileActionsCommon.js'

export class ExplorerOpenPreviewAction extends Action2 {
  static readonly ID = 'workbench.files.action.openPreview'

  constructor() {
    super({
      id: ExplorerOpenPreviewAction.ID,
      title: localize2('action.explorer.openPreview.title', 'Open Preview'),
      // Not in the palette: the markdown / html editor actions already register
      // two "Open Preview" entries there, and this one carries no precondition
      // to tell them apart — it would only add a third that can silently no-op.
      f1: false,
    })
  }

  override run(accessor: ServicesAccessor, ...args: unknown[]): void {
    // args[1] is the Explorer multi-selection array, not an options bag: the
    // preview acts on the primary resource only, like the hover button and
    // ScmOpenPreviewAction. resolvePrimaryTarget reads args[0] alone.
    const resource = resolvePrimaryTarget(args)
    if (!resource) return
    const groups = accessor.get(IEditorGroupsService)
    openResourcePreviewInGroup(groups, groups.activeGroup, resource)
  }
}
