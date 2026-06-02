/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Help-menu Action2 commands: open the built-in guide documents.
 *  *  Help commands. ShowReleaseNotes opens a markdown tab with the full version
 *  history (the upgrade-time "what's new" tab is driven by ReleaseNotesContribution).
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorService,
  IEditorGroupsService,
  MenuId,
  localize,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { DocEditorInput } from '../services/editor/DocEditorInput.js'
import { IReleaseNotesService } from '../../shared/ipc/releaseNotesService.js'
import { ReleaseNotesInput } from '../services/editor/ReleaseNotesInput.js'
import { renderReleaseNotesMarkdown } from '../services/releaseNotes/releaseNotes.js'

export class OpenEditorGuideAction extends Action2 {
  static readonly ID = 'workbench.action.openEditorGuide'
  constructor() {
    super({
      id: OpenEditorGuideAction.ID,
      title: localize('action.openEditorGuide.title', 'Editor Guide'),
      category: localize('command.category.help', 'Help'),
      menu: { id: MenuId.MenubarHelpMenu, group: '0_docs', order: 1 },
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    accessor.get(IEditorService).openEditor(new DocEditorInput('editor-guide'))
  }
}

export class OpenAgentGuideAction extends Action2 {
  static readonly ID = 'workbench.action.openAgentGuide'
  constructor() {
    super({
      id: OpenAgentGuideAction.ID,
      title: localize('action.openAgentGuide.title', 'Agent Guide'),
      category: localize('command.category.help', 'Help'),
      menu: { id: MenuId.MenubarHelpMenu, group: '0_docs', order: 2 },
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    accessor.get(IEditorService).openEditor(new DocEditorInput('agent-guide'))
  }
}

export class ShowReleaseNotesAction extends Action2 {
  static readonly ID = 'workbench.action.showReleaseNotes'
  constructor() {
    super({
      id: ShowReleaseNotesAction.ID,
      title: localize('releaseNotes.show', 'Show Release Notes'),
      category: localize('command.category.help', 'Help'),
      menu: { id: MenuId.MenubarHelpMenu, group: '0_docs', order: 3 },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const releaseNotes = accessor.get(IReleaseNotesService)
    const groups = accessor.get(IEditorGroupsService)
    const { notes } = await releaseNotes.getReleaseNotes()
    const markdown =
      notes.length > 0
        ? renderReleaseNotesMarkdown(notes)
        : localize('releaseNotes.empty', 'No release notes are available.')
    const input = new ReleaseNotesInput(
      markdown,
      localize('releaseNotes.title', 'Release Notes'),
      'all',
    )
    groups.activeGroup.openEditor(input, { activate: true, pinned: true })
  }
}
