/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers the extensions.* settings that drive the update checker. VSCode parity
 *  for the key names and defaults; the interval itself is not configurable (neither
 *  is VSCode's).
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationRegistry,
  Disposable,
  IWorkbenchContribution,
  localize,
} from '@universe-editor/platform'

export class ExtensionsConfigurationContribution
  extends Disposable
  implements IWorkbenchContribution
{
  constructor() {
    super()
    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'extensions',
        title: localize('settings.extensions', 'Extensions'),
        properties: {
          'extensions.autoCheckUpdates': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.extensions.autoCheckUpdates',
              'Check for extension updates automatically (shortly after startup, then every 12 hours).',
            ),
          },
          'extensions.autoUpdate': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.extensions.autoUpdate',
              'Install available extension updates automatically. When off, updates are still detected and offered.',
            ),
          },
          'extensions.autoUpdateDelay': {
            type: 'number',
            default: 2,
            minimum: 0,
            description: localize(
              'settings.extensions.autoUpdateDelay',
              'Hours to wait after an update is published before installing it automatically. An extension you disabled or opted out of is never updated automatically.',
            ),
          },
        },
      }),
    )
  }
}
