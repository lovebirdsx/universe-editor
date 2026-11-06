/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers the breadcrumb settings. BlockStartup so the Settings editor sees
 *  the schema before the first FileEditor mounts.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationRegistry,
  Disposable,
  localize,
  type IWorkbenchContribution,
} from '@universe-editor/platform'

export class BreadcrumbsConfigurationContribution
  extends Disposable
  implements IWorkbenchContribution
{
  constructor() {
    super()
    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'breadcrumbs',
        title: localize('settings.breadcrumbs', 'Breadcrumbs'),
        properties: {
          'breadcrumbs.enabled': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.breadcrumbs.enabled',
              'Enable breadcrumbs above the editor.',
            ),
          },
          'breadcrumbs.filePath': {
            type: 'string',
            enum: ['on', 'off', 'last'],
            enumDescriptions: [
              localize('settings.breadcrumbs.filePath.on', 'Show the full file path.'),
              localize('settings.breadcrumbs.filePath.off', 'Hide the file path.'),
              localize(
                'settings.breadcrumbs.filePath.last',
                'Show only the last file path segment.',
              ),
            ],
            default: 'on',
            description: localize(
              'settings.breadcrumbs.filePath',
              'Controls whether and how the file path is shown in breadcrumbs.',
            ),
          },
          'breadcrumbs.symbolPath': {
            type: 'string',
            enum: ['on', 'off', 'last'],
            enumDescriptions: [
              localize('settings.breadcrumbs.symbolPath.on', 'Show the full symbol path.'),
              localize('settings.breadcrumbs.symbolPath.off', 'Hide the symbol path.'),
              localize('settings.breadcrumbs.symbolPath.last', 'Show only the last symbol.'),
            ],
            default: 'on',
            description: localize(
              'settings.breadcrumbs.symbolPath',
              'Controls whether and how the symbol path is shown in breadcrumbs.',
            ),
          },
          'breadcrumbs.icons': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.breadcrumbs.icons',
              'Show file and symbol icons in breadcrumbs.',
            ),
          },
          'breadcrumbs.symbolSortOrder': {
            type: 'string',
            enum: ['position', 'name', 'type'],
            enumDescriptions: [
              localize(
                'settings.breadcrumbs.symbolSortOrder.position',
                'Sort symbols by position in the file.',
              ),
              localize('settings.breadcrumbs.symbolSortOrder.name', 'Sort symbols by name.'),
              localize('settings.breadcrumbs.symbolSortOrder.type', 'Sort symbols by kind.'),
            ],
            default: 'position',
            description: localize(
              'settings.breadcrumbs.symbolSortOrder',
              'Controls the sort order of the symbol breadcrumb picker.',
            ),
          },
        },
      }),
    )
  }
}
