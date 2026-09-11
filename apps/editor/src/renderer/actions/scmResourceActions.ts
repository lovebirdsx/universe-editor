/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SCM resource-row actions — the host-owned "open" entries every provider's rows
 *  share: open the file, open its rendered preview.
 *
 *  They are contributed to the right-click menu's `1_open` group so the open
 *  actions sit together at the top (VSCode parity). The row hover strip renders
 *  them as well — see SCM_HOVER_LEADING_COMMANDS. Both surfaces now read one menu
 *  contribution; what this replaces were two buttons hard-coded in ScmView that
 *  no context menu could reach.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorGroupsService,
  IEditorResolverService,
  IWorkspaceService,
  MenuId,
  fsPathToWorkspaceUri,
  localize2,
  type ServicesAccessor,
  type URI,
} from '@universe-editor/platform'
import { currentRemoteAuthority } from '../services/remote/windowRemoteAuthority.js'
import { openResourcePreviewInGroup } from '../services/resourcePreview/openResourcePreview.js'
import { scmResourceArgPath } from '../services/scm/scmResourceArg.js'
import { SCM_OPEN_FILE_COMMAND, SCM_OPEN_PREVIEW_COMMAND } from '../services/scm/scmRowCommands.js'

/**
 * Reattach the window's remote authority to a row's host fs-path, so a remote
 * workspace opens the remote file rather than a same-named local one. Mirrors
 * ScmView's `useRemoteAuthority()`. Deliberately not `extensionApiActions`'
 * workspaceResourceUri: that one skips the WSL authority normalization and the
 * empty-remote-window argv fallback, so a remote window would resolve a
 * different authority than the hover buttons did.
 *
 * Read synchronously — a ServicesAccessor is only valid for the part of run()
 * before the first await.
 */
function rowUri(accessor: ServicesAccessor, fsPath: string): URI {
  return fsPathToWorkspaceUri(
    fsPath,
    currentRemoteAuthority(accessor.get(IWorkspaceService).current),
  )
}

/** Row hover button "Open File" and its right-click entry. */
export class ScmOpenFileAction extends Action2 {
  static readonly ID = SCM_OPEN_FILE_COMMAND

  constructor() {
    super({
      id: ScmOpenFileAction.ID,
      title: localize2('action.scm.openFile.title', 'Open File'),
      icon: 'go-to-file',
      // Gated on the row's own claim: a provider marks a row `noHostFile` when
      // its path names no local file (p4's shelved rows carry a depot path), and
      // opening one would only produce a URI to a file that isn't there.
      menu: {
        id: MenuId.ScmResourceStateContext,
        group: '1_open',
        order: 2,
        when: 'scmResourceHasHostFile',
      },
    })
  }

  override run(accessor: ServicesAccessor, arg?: unknown): void {
    const fsPath = scmResourceArgPath(arg)
    if (fsPath === undefined) return
    void accessor.get(IEditorResolverService).openEditor(rowUri(accessor, fsPath), { pinned: true })
  }
}

/** Row hover button "Open Preview" and its right-click entry. */
export class ScmOpenPreviewAction extends Action2 {
  static readonly ID = SCM_OPEN_PREVIEW_COMMAND

  constructor() {
    super({
      id: ScmOpenPreviewAction.ID,
      title: localize2('action.scm.openPreview.title', 'Open Preview'),
      icon: 'open-preview',
      // `menu.when`, never `precondition`: the key only exists in ScmView's
      // row-scoped context. A precondition is ANDed into every placement of the
      // action and evaluated against the root context, where the key is always
      // unset — the entry and any keybinding would silently never match.
      menu: {
        id: MenuId.ScmResourceStateContext,
        group: '1_open',
        order: 3,
        when: 'scmResourcePreviewable',
      },
    })
  }

  override run(accessor: ServicesAccessor, arg?: unknown): void {
    const fsPath = scmResourceArgPath(arg)
    if (fsPath === undefined) return
    const groups = accessor.get(IEditorGroupsService)
    openResourcePreviewInGroup(groups, groups.activeGroup, rowUri(accessor, fsPath))
  }
}
