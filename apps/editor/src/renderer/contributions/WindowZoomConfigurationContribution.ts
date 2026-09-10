/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers `window.zoomLevel` — the whole-window UI scale factor. Read by the
 *  main process at startup to restore the configured zoom before first paint.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationRegistry,
  Disposable,
  IWorkbenchContribution,
  localize,
} from '@universe-editor/platform'

export class WindowZoomConfigurationContribution
  extends Disposable
  implements IWorkbenchContribution
{
  constructor() {
    super()
    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'window',
        title: localize('settings.window', 'Window'),
        properties: {
          'window.zoomLevel': {
            type: 'number',
            default: 1,
            description: localize(
              'settings.window.zoomLevel',
              'Scale factor for the whole window UI. `1` is 100%, `1.25` is 125%. Use this to match the host display scaling on platforms where the OS scale is not propagated to the app (e.g. WSLg). Ctrl+= / Ctrl+- adjust zoom temporarily for the session; this setting is the value restored at startup.',
            ),
          },
        },
      }),
    )
  }
}
