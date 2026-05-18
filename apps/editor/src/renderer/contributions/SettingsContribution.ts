/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Seed built-in configuration schema. Acts as the source of truth for the
 *  Settings editor UI; future themes / extensions append more nodes via the
 *  same ConfigurationRegistry API.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationRegistry,
  Disposable,
  IWorkbenchContribution,
} from '@universe-editor/platform'

export class SettingsContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()

    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'workbench',
        title: 'Workbench',
        properties: {
          'workbench.colorTheme': {
            type: 'string',
            default: 'dark',
            enum: ['dark', 'light'],
            description: 'Workbench color theme.',
          },
          'workbench.sideBar.location': {
            type: 'string',
            default: 'left',
            enum: ['left', 'right'],
            description: 'Side bar location.',
          },
        },
      }),
    )

    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'editor',
        title: 'Editor',
        properties: {
          'editor.fontSize': {
            type: 'number',
            default: 14,
            minimum: 8,
            maximum: 32,
            description: 'Controls the editor font size in pixels.',
          },
          'editor.tabSize': {
            type: 'number',
            default: 4,
            minimum: 1,
            maximum: 8,
            description: 'Number of spaces a tab is equal to.',
          },
          'editor.wordWrap': {
            type: 'boolean',
            default: false,
            description: 'Controls whether lines wrap.',
          },
          'editor.minimap.enabled': {
            type: 'boolean',
            default: true,
            description: 'Controls whether the minimap is shown.',
          },
        },
      }),
    )

    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'files',
        title: 'Files',
        properties: {
          'files.autoSave': {
            type: 'string',
            default: 'off',
            enum: ['off', 'afterDelay', 'onFocusChange'],
            description: 'Controls auto save of dirty files.',
          },
          'files.autoSaveDelay': {
            type: 'number',
            default: 1000,
            minimum: 100,
            description: 'Auto save delay in milliseconds (when autoSave=afterDelay).',
          },
        },
      }),
    )

    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'explorer',
        title: 'Explorer',
        properties: {
          'explorer.autoReveal': {
            type: 'boolean',
            default: true,
            description:
              'Controls whether the Explorer should automatically reveal and select files when opening them.',
          },
        },
      }),
    )
  }
}
