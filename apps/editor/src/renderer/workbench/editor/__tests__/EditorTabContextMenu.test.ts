/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Regression guard: the editor tab right-click menu must gate its entries on
 *  the *clicked* tab. Path commands (Copy Path/Relative Path, Reveal, Reopen
 *  With) only show for on-disk `file:` tabs; "Copy Name" shows for *every* tab
 *  (it copies the input's display name); "Rename Agent Session…" only for
 *  acp.session tabs. A diff tab (virtual `diff:` scheme) shows only Copy Name.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  ContextKeyService,
  MenuRegistry,
  MenuId,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import {
  CopyEditorNameAction,
  CopyFilePathAction,
  CopyFileRelativePathAction,
} from '../../../actions/fileCopyActions.js'
import { RevealInExplorerAction, RevealInOSExplorerAction } from '../../../actions/revealActions.js'
import { ReopenWithAction } from '../../../actions/editorResolverActions.js'
import { RenameAgentSessionAction } from '../../../actions/agentSessionActions.js'
import { AcpSessionEditorInput } from '../../../services/acp/acpSessionEditorInput.js'
import { MarkdownPreviewInput } from '../../../services/editor/MarkdownPreviewInput.js'

const disposables: IDisposable[] = []

function register(): void {
  disposables.push(
    registerAction2(CopyEditorNameAction),
    registerAction2(CopyFilePathAction),
    registerAction2(CopyFileRelativePathAction),
    registerAction2(RevealInExplorerAction),
    registerAction2(RevealInOSExplorerAction),
    registerAction2(ReopenWithAction),
    registerAction2(RenameAgentSessionAction),
    // "Reopen With…" is registered as a bare MenuRegistry item (not via the
    // ReopenWithAction's own menu), mirroring BuiltInEditorBindingsContribution.
    MenuRegistry.addMenuItem(MenuId.EditorTabContext, {
      command: ReopenWithAction.ID,
      title: 'Reopen With...',
      when: 'resourceScheme == file',
      group: 'z_commands',
      order: 1,
    }),
  )
}

function menuCommandsFor(overrides: Record<string, unknown>): string[] {
  const ctx = new ContextKeyService().createScoped(overrides)
  disposables.push(ctx)
  return MenuRegistry.getMenuItems(MenuId.EditorTabContext, ctx)
    .filter((e): e is { command: string } => 'command' in e)
    .map((e) => e.command)
}

// Path commands that require an on-disk `file:` resource.
const PATH_COMMANDS = [
  CopyFilePathAction.ID,
  CopyFileRelativePathAction.ID,
  RevealInExplorerAction.ID,
  RevealInOSExplorerAction.ID,
  ReopenWithAction.ID,
]

afterEach(() => {
  while (disposables.length) disposables.pop()!.dispose()
})

describe('EditorTabContext menu — per-tab gating', () => {
  it('a diff tab shows Copy Name but no path commands nor Rename Agent Session', () => {
    register()
    const commands = menuCommandsFor({ resourceScheme: 'diff', activeEditorType: 'diff' })
    expect(commands).toContain(CopyEditorNameAction.ID)
    for (const id of PATH_COMMANDS) expect(commands).not.toContain(id)
    expect(commands).not.toContain(RenameAgentSessionAction.ID)
  })

  it('a file tab shows Copy Name and the path commands but not Rename Agent Session', () => {
    register()
    const commands = menuCommandsFor({ resourceScheme: 'file', activeEditorType: 'file' })
    expect(commands).toContain(CopyEditorNameAction.ID)
    for (const id of PATH_COMMANDS) expect(commands).toContain(id)
    expect(commands).not.toContain(RenameAgentSessionAction.ID)
  })

  it('a markdown preview tab shows the path commands (resource mapped to the source .md)', () => {
    // EditorGroupView maps a preview tab's virtual `markdown-preview:` URI to its
    // source `file:` URI, so the scoped `resourceScheme` is `file` even though the
    // editor type is markdown.preview. The file commands must appear.
    register()
    const commands = menuCommandsFor({
      resourceScheme: 'file',
      activeEditorType: MarkdownPreviewInput.TYPE_ID,
    })
    expect(commands).toContain(CopyEditorNameAction.ID)
    for (const id of PATH_COMMANDS) expect(commands).toContain(id)
    expect(commands).not.toContain(RenameAgentSessionAction.ID)
  })

  it('an acp.session tab shows Copy Name and Rename Agent Session but no path commands', () => {
    register()
    const commands = menuCommandsFor({
      resourceScheme: 'universe',
      activeEditorType: AcpSessionEditorInput.TYPE_ID,
    })
    expect(commands).toContain(CopyEditorNameAction.ID)
    expect(commands).toContain(RenameAgentSessionAction.ID)
    for (const id of PATH_COMMANDS) expect(commands).not.toContain(id)
  })
})
