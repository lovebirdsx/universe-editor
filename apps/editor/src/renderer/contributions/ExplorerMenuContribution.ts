import {
  Disposable,
  type IWorkbenchContribution,
  MenuId,
  MenuRegistry,
} from '@universe-editor/platform'

export class ExplorerMenuContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()

    // 1_new group
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

    // 2_edit group
    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'workbench.files.action.rename',
        group: '2_edit',
        order: 1,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'workbench.files.action.delete',
        group: '2_edit',
        order: 2,
      }),
    )

    // 3_open group
    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'workbench.files.action.openWithDefaultApp',
        group: '3_open',
        order: 1,
      }),
    )
    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'workbench.files.action.revealInOsExplorer',
        group: '3_open',
        order: 2,
      }),
    )

    // 4_misc group
    this._register(
      MenuRegistry.addMenuItem(MenuId.ExplorerContext, {
        command: 'workbench.files.action.refresh',
        group: '4_misc',
        order: 1,
      }),
    )
  }
}
