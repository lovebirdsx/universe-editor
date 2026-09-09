/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Regression guard: the editor tab right-click menu must gate its entries on
 *  the *clicked* tab. Path commands (Copy Path/Relative Path, Reveal, Reopen
 *  With) only show for on-disk `file:` tabs; "Copy Name" shows for *every* tab
 *  (it copies the input's display name); "Rename Agent Session…" and "Open
 *  Session Location" only for acp.session tabs. A diff tab (virtual `diff:`
 *  scheme) shows only Copy Name. A remote (`remote-ssh`) tab shows Copy Name
 *  plus the filesystem-backed path commands, but not OS reveal nor Reopen With
 *  (both still gated on `file:` / extra context keys).
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
import {
  CloseActiveEditorAction,
  PinEditorAction,
  UnpinEditorAction,
} from '../../../actions/editorActions.js'
import {
  RenameAgentSessionAction,
  RevealAgentSessionInOSAction,
} from '../../../actions/agentSessionActions.js'
import { AcpSessionEditorInput } from '../../../services/acp/session/acpSessionEditorInput.js'
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
    registerAction2(RevealAgentSessionInOSAction),
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
  return menuGroupsFor(overrides).map(([command]) => command)
}

function menuGroupsFor(overrides: Record<string, unknown>): [string, string][] {
  const ctx = new ContextKeyService().createScoped(overrides)
  disposables.push(ctx)
  return MenuRegistry.getMenuItems(MenuId.EditorTabContext, ctx)
    .filter((e): e is { command: string; group?: string } => 'command' in e)
    .map((e) => [e.command, e.group ?? ''])
}

// Path commands that require an on-disk `file:` resource.
const PATH_COMMANDS = [
  CopyFilePathAction.ID,
  CopyFileRelativePathAction.ID,
  RevealInExplorerAction.ID,
  RevealInOSExplorerAction.ID,
  ReopenWithAction.ID,
]

// Path commands a filesystem-backed (`file:` / `remote-ssh`) tab offers —
// excludes Reveal in OS (needs `remoteRevealInOsSupported`) and Reopen With.
const REMOTE_PATH_COMMANDS = [
  CopyFilePathAction.ID,
  CopyFileRelativePathAction.ID,
  RevealInExplorerAction.ID,
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

  it('an acp.session tab shows Copy Name and the session commands but no path commands', () => {
    register()
    const commands = menuCommandsFor({
      resourceScheme: 'universe',
      activeEditorType: AcpSessionEditorInput.TYPE_ID,
    })
    expect(commands).toContain(CopyEditorNameAction.ID)
    expect(commands).toContain(RenameAgentSessionAction.ID)
    expect(commands).toContain(RevealAgentSessionInOSAction.ID)
    for (const id of PATH_COMMANDS) expect(commands).not.toContain(id)
  })

  it('a remote-ssh tab shows Copy Name and the filesystem path commands, not OS reveal nor Reopen With', () => {
    register()
    const commands = menuCommandsFor({ resourceScheme: 'remote-ssh', activeEditorType: 'file' })
    expect(commands).toContain(CopyEditorNameAction.ID)
    for (const id of REMOTE_PATH_COMMANDS) expect(commands).toContain(id)
    expect(commands).not.toContain(RevealInOSExplorerAction.ID)
    expect(commands).not.toContain(ReopenWithAction.ID)
  })

  it('a file tab does not show the session reveal command', () => {
    register()
    const commands = menuCommandsFor({ resourceScheme: 'file', activeEditorType: 'file' })
    expect(commands).not.toContain(RevealAgentSessionInOSAction.ID)
  })
})

describe('EditorTabContext menu — pin/unpin gating', () => {
  // Pin and Unpin are gated on the per-tab `activeEditorIsPinned` override, so
  // right-clicking a non-active tab must offer exactly the entry matching that
  // tab's sticky state, never the active editor's. The actions also carry the
  // `hasActiveEditor` precondition, so the override must seed it as if the tab
  // were active.
  it('a non-sticky tab offers Pin Editor and hides Unpin, grouped under 3_preview', () => {
    disposables.push(
      registerAction2(PinEditorAction),
      registerAction2(UnpinEditorAction),
      registerAction2(CloseActiveEditorAction),
    )
    const groups = new Map(menuGroupsFor({ activeEditorIsPinned: false, hasActiveEditor: true }))
    expect(groups.get(PinEditorAction.ID)).toBe('3_preview')
    expect(groups.has(UnpinEditorAction.ID)).toBe(false)
    // Close stays available on a non-sticky tab.
    expect(groups.has(CloseActiveEditorAction.ID)).toBe(true)
  })

  it('a sticky tab offers Unpin Editor and hides Pin, grouped under 3_preview', () => {
    disposables.push(
      registerAction2(PinEditorAction),
      registerAction2(UnpinEditorAction),
      registerAction2(CloseActiveEditorAction),
    )
    const groups = new Map(menuGroupsFor({ activeEditorIsPinned: true, hasActiveEditor: true }))
    expect(groups.get(UnpinEditorAction.ID)).toBe('3_preview')
    expect(groups.has(PinEditorAction.ID)).toBe(false)
  })
})
