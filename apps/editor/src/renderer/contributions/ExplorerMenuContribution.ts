import {
  Disposable,
  type IWorkbenchContribution,
  MenuId,
  MenuRegistry,
} from '@universe-editor/platform'

export class ExplorerMenuContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()

    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'workbench.files.action.newFile',
        group: '1_new',
        order: 1,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'workbench.files.action.newFolder',
        group: '1_new',
        order: 2,
      }),
    )

    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'filesExplorer.cut',
        when: '!explorerResourceIsRoot',
        group: '2_cutcopypaste',
        order: 1,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'filesExplorer.copy',
        when: '!explorerResourceIsRoot',
        group: '2_cutcopypaste',
        order: 2,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'filesExplorer.paste',
        when: 'fileCopied && explorerResourceIsFolder',
        group: '2_cutcopypaste',
        order: 3,
      }),
    )

    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'workbench.files.action.rename',
        when: '!explorerResourceIsRoot',
        group: '3_modification',
        order: 1,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'workbench.files.action.duplicate',
        when: '!explorerResourceIsRoot',
        group: '3_modification',
        order: 2,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'workbench.files.action.move',
        when: '!explorerResourceIsRoot',
        group: '3_modification',
        order: 3,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'workbench.files.action.delete',
        when: '!explorerResourceIsRoot',
        group: '3_modification',
        order: 4,
      }),
    )

    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'workbench.files.action.copyName',
        group: '4_copy',
        order: 1,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'copyFilePath',
        group: '4_copy',
        order: 2,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'copyRelativeFilePath',
        group: '4_copy',
        order: 3,
      }),
    )

    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'workbench.files.action.openWithDefaultApp',
        when: '!explorerResourceIsFolder',
        group: '5_open',
        order: 1,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'workbench.files.action.revealInOsExplorer',
        group: '5_open',
        order: 2,
      }),
    )

    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'workbench.files.action.refresh',
        group: '6_misc',
        order: 1,
      }),
    )
  }
}
