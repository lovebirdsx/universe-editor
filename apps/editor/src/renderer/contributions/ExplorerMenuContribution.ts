import {
  Disposable,
  type IWorkbenchContribution,
  MenuId,
  MenuRegistry,
} from '@universe-editor/platform'
import {
  AddFolderToFocusAction,
  FocusOnFolderAction,
  RemoveFolderFromFocusAction,
} from '../actions/focusScopeActions.js'
import { NewAgentSessionInFolderAction } from '../actions/agentSessionActions.js'

export class ExplorerMenuContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()

    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'workbench.files.action.newFile',
        icon: 'new-file',
        group: '1_new',
        order: 1,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'workbench.files.action.newFolder',
        icon: 'new-folder',
        group: '1_new',
        order: 2,
      }),
    )

    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'filesExplorer.cut',
        icon: 'cut',
        when: '!explorerResourceIsRoot',
        group: '2_cutcopypaste',
        order: 1,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'filesExplorer.copy',
        icon: 'copy',
        when: '!explorerResourceIsRoot',
        group: '2_cutcopypaste',
        order: 2,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'filesExplorer.paste',
        icon: 'paste',
        // Always visible on folders: the OS clipboard can carry files copied
        // in other applications, so emptiness is only known at run time.
        when: 'explorerResourceIsFolder',
        group: '2_cutcopypaste',
        order: 3,
      }),
    )

    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'workbench.files.action.rename',
        icon: 'edit',
        when: '!explorerResourceIsRoot',
        group: '3_modification',
        order: 1,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'workbench.files.action.duplicate',
        icon: 'duplicate',
        when: '!explorerResourceIsRoot',
        group: '3_modification',
        order: 2,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'workbench.files.action.move',
        icon: 'move',
        when: '!explorerResourceIsRoot',
        group: '3_modification',
        order: 3,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'workbench.files.action.delete',
        icon: 'trash',
        when: '!explorerResourceIsRoot',
        group: '3_modification',
        order: 4,
      }),
    )

    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'selectForCompare',
        icon: 'compare-changes',
        when: '!explorerResourceIsFolder && !explorerResourceMultiSelected',
        group: '3_compare',
        order: 1,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'compareSelected',
        icon: 'compare-changes',
        when: '!explorerResourceIsFolder && resourceSelectedForCompare && !explorerResourceMultiSelected',
        group: '3_compare',
        order: 2,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'workbench.files.action.compareFiles',
        icon: 'compare-changes',
        when: 'explorerResourceTwoSelected',
        group: '3_compare',
        order: 3,
      }),
    )

    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'files.openTimeline',
        icon: 'history',
        when: 'timelineHasProvider && !explorerResourceIsFolder',
        group: '4_timeline',
        order: 1,
      }),
    )

    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'filesExplorer.findInFolder',
        icon: 'find-in-folder',
        when: 'explorerResourceIsFolder',
        group: '4_search',
        order: 10,
      }),
    )

    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'workbench.files.action.copyName',
        icon: 'copy',
        group: '4_copy',
        order: 1,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'copyFilePath',
        icon: 'copy',
        group: '4_copy',
        order: 2,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'copyRelativeFilePath',
        icon: 'copy',
        group: '4_copy',
        order: 3,
      }),
    )

    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'workbench.files.action.openWithDefaultApp',
        icon: 'open-with',
        when: '!explorerResourceIsFolder && (resourceScheme == file || resourceScheme == remote-ssh && remoteRevealInOsSupported)',
        group: '5_open',
        order: 1,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'workbench.files.action.revealInOsExplorer',
        icon: 'reveal',
        when: 'resourceScheme == file || resourceScheme == remote-ssh && remoteRevealInOsSupported',
        group: '5_open',
        order: 2,
      }),
    )

    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'workbench.files.action.refresh',
        icon: 'refresh',
        group: '6_misc',
        order: 1,
      }),
    )

    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: FocusOnFolderAction.ID,
        icon: 'focus',
        when: 'explorerResourceIsFolder && !explorerResourceIsRoot && !explorerResourceIsFocusFolder',
        group: '7_focus',
        order: 1,
      }),
    )
    // Only once a focus set exists: with focus off, adding to it and focusing on
    // it are the same operation, and offering both invites a coin flip.
    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: AddFolderToFocusAction.ID,
        icon: 'add',
        when: 'explorerResourceIsFolder && !explorerResourceIsRoot && !explorerResourceIsFocusFolder && focusScopeActive',
        group: '7_focus',
        order: 2,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: RemoveFolderFromFocusAction.ID,
        icon: 'remove',
        when: 'explorerResourceIsFolder && !explorerResourceIsRoot && explorerResourceIsFocusFolder',
        group: '7_focus',
        order: 3,
      }),
    )

    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: NewAgentSessionInFolderAction.ID,
        icon: 'sparkle',
        when: 'explorerResourceIsFolder',
        group: '7_agent',
        order: 1,
      }),
    )
  }
}
