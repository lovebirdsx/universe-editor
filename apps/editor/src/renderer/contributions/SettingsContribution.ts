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
  localize,
} from '@universe-editor/platform'
import { DISPLAY_LANGUAGE_SETTING_KEY } from '../../shared/i18n/availableLocales.js'
import {
  EDITOR_FONT_FAMILY_DEFAULT,
  WORKBENCH_FONT_FAMILY_DEFAULT,
} from '../services/configuration/fontDefaults.js'

export class SettingsContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()

    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'workbench',
        title: localize('settings.title.workbench', 'Workbench'),
        properties: {
          [DISPLAY_LANGUAGE_SETTING_KEY]: {
            type: 'string',
            default: 'auto',
            enum: ['auto', 'en-US', 'zh-CN'],
            enumItemLabels: {
              auto: localize('settings.enum.auto', 'Use System Language'),
              'en-US': localize('settings.enum.en-US', 'English'),
              'zh-CN': localize('settings.enum.zh-CN', 'Simplified Chinese'),
            },
            description: localize(
              'settings.language.description',
              'Controls the display language. Changes require a restart.',
            ),
          },
          'workbench.colorTheme': {
            type: 'string',
            default: 'dark',
            enum: ['dark', 'light'],
            enumItemLabels: {
              dark: localize('settings.enum.dark', 'Dark'),
              light: localize('settings.enum.light', 'Light'),
            },
            description: localize(
              'settings.workbench.colorTheme.description',
              'Workbench color theme.',
            ),
          },
          'workbench.fontFamily': {
            type: 'string',
            default: WORKBENCH_FONT_FAMILY_DEFAULT,
            description: localize(
              'settings.workbench.fontFamily.description',
              'Controls the font family of the workbench UI.',
            ),
          },
        },
      }),
    )

    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'editor',
        title: localize('settings.editor', 'Editor'),
        properties: {
          'editor.fontSize': {
            type: 'number',
            default: 14,
            minimum: 8,
            maximum: 32,
            description: localize(
              'settings.editor.fontSize.description',
              'Controls the editor font size in pixels.',
            ),
          },
          'editor.fontFamily': {
            type: 'string',
            default: EDITOR_FONT_FAMILY_DEFAULT,
            description: localize(
              'settings.editor.fontFamily.description',
              'Controls the editor font family.',
            ),
          },
          'editor.tabSize': {
            type: 'number',
            default: 4,
            minimum: 1,
            maximum: 8,
            description: localize(
              'settings.editor.tabSize.description',
              'Number of spaces a tab is equal to.',
            ),
          },
          'editor.wordWrap': {
            type: 'boolean',
            default: false,
            description: localize(
              'settings.editor.wordWrap.description',
              'Controls whether lines wrap.',
            ),
          },
          'editor.minimap.enabled': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.editor.minimap.description',
              'Controls whether the minimap is shown.',
            ),
          },
        },
      }),
    )

    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'files',
        title: localize('settings.files', 'Files'),
        properties: {
          'files.autoSave': {
            type: 'string',
            default: 'off',
            enum: ['off', 'afterDelay', 'onFocusChange'],
            enumItemLabels: {
              off: localize('settings.enum.off', 'Off'),
              afterDelay: localize('settings.enum.afterDelay', 'After Delay'),
              onFocusChange: localize('settings.enum.onFocusChange', 'On Focus Change'),
            },
            description: localize(
              'settings.files.autoSave.description',
              'Controls auto save of dirty files.',
            ),
          },
          'files.autoSaveDelay': {
            type: 'number',
            default: 1000,
            minimum: 100,
            description: localize(
              'settings.files.autoSaveDelay.description',
              'Auto save delay in milliseconds (when autoSave=afterDelay).',
            ),
          },
        },
      }),
    )

    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'explorer',
        title: localize('settings.explorer', 'Explorer'),
        properties: {
          'explorer.autoReveal': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.explorer.autoReveal.description',
              'Controls whether the Explorer should automatically reveal and select files when opening them.',
            ),
          },
          'workbench.tree.virtualizationThreshold': {
            type: 'number',
            default: 200,
            minimum: 10,
            description: localize(
              'settings.workbench.tree.virtualizationThreshold.description',
              'Number of visible tree items above which virtual scrolling is enabled.',
            ),
          },
        },
      }),
    )

    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'logging',
        title: localize('settings.logging', 'Logging'),
        properties: {
          'logging.level': {
            type: 'string',
            default: 'info',
            enum: ['off', 'trace', 'debug', 'info', 'warning', 'error'],
            description: localize(
              'settings.logging.level.description',
              'Default log level applied at startup.',
            ),
          },
          'logging.timestampFormat': {
            type: 'string',
            default: 'HH:mm:ss',
            enum: ['HH:mm:ss', 'HH:mm:ss.SSS', 'ISO'],
            enumItemLabels: {
              'HH:mm:ss': localize('settings.enum.timestampHHmmss', 'Time (09:11:25)'),
              'HH:mm:ss.SSS': localize(
                'settings.enum.timestampHHmmssSSS',
                'Time with ms (09:11:25.123)',
              ),
              ISO: localize('settings.enum.timestampISO', 'ISO 8601 UTC'),
            },
            description: localize(
              'settings.logging.timestampFormat.description',
              'Timestamp format used in log output.',
            ),
          },
        },
      }),
    )
  }
}
