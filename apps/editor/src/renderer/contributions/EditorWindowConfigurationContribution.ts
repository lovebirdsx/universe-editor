/*---------------------------------------------------------------------------------------------
 *  Registers editor-window settings. `workbench.editor.dragToOpenWindow` mirrors
 *  VSCode: dragging an editor tab out of every workbench window opens it in a
 *  new auxiliary window (and closes the source tab).
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationRegistry,
  Disposable,
  type IWorkbenchContribution,
  localize,
} from '@universe-editor/platform'

export class EditorWindowConfigurationContribution
  extends Disposable
  implements IWorkbenchContribution
{
  constructor() {
    super()
    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'workbench.editor',
        title: localize('settings.workbench.editor', 'Editor'),
        properties: {
          'workbench.editor.dragToOpenWindow': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.workbench.editor.dragToOpenWindow',
              'Controls whether dragging an editor tab outside of every editor window opens it in a new window.',
            ),
          },
        },
      }),
    )
  }
}
