/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * ThemesContribution（BlockStartup）—— 主题系统的装配点：
 * - 触发 WorkbenchThemeService.initialize（等扩展主题注册后应用配置主题）；
 * - 挂载 Monaco 主题桥（全局 Monaco 主题唯一事实源）与主题文件 watcher（热更新）；
 * - 维护 `workbench.colorTheme` 配置 schema 的动态 enum（跟随主题注册表，
 *   对等 VSCode 的 updateColorThemeConfigurationSchemas）。
 */

import {
  ConfigurationRegistry,
  Disposable,
  IConfigurationService,
  IFileWatcherService,
  ILoggerService,
  IThemeService,
  localize,
  NullLogger,
  type IDisposable,
  type ILogger,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { IOutOfWorkspaceWatchService } from '../services/files/outOfWorkspaceWatchService.js'
import { initMonacoThemeBridge } from '../services/themes/monacoThemeBridge.js'
import { DEFAULT_DARK_COLOR_THEME_ID } from '../services/themes/themeConfiguration.js'
import { ThemeFileWatcher } from '../services/themes/themeFileWatcher.js'
import { registerUniverseColorIds } from '../services/themes/universeColorIds.js'
import type { WorkbenchThemeService } from '../services/themes/workbenchThemeService.js'

export class ThemesContribution extends Disposable implements IWorkbenchContribution {
  private readonly _logger: ILogger
  private _colorThemeSchemaHandle: IDisposable | undefined

  constructor(
    @IThemeService private readonly _themeService: WorkbenchThemeService,
    @IConfigurationService private readonly _configurationService: IConfigurationService,
    @IFileWatcherService fileWatcherService: IFileWatcherService,
    @IOutOfWorkspaceWatchService outOfWorkspaceWatch: IOutOfWorkspaceWatchService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    // The CSS generator and getColor() consumers resolve against this registry;
    // it must be populated before initialize() applies the first theme.
    registerUniverseColorIds()
    this._logger = loggerService?.createLogger({ id: 'theme', name: 'Theme' }) ?? new NullLogger()
    this._register(initMonacoThemeBridge(_themeService, _configurationService, this._logger))
    this._register(
      new ThemeFileWatcher(_themeService, fileWatcherService, outOfWorkspaceWatch, this._logger),
    )
    this._updateColorThemeSchema()
    this._register(this._themeService.onDidChangeColorThemes(() => this._updateColorThemeSchema()))
    void this._themeService.initialize()
  }

  override dispose(): void {
    this._colorThemeSchemaHandle?.dispose()
    super.dispose()
  }

  private _updateColorThemeSchema(): void {
    const themes = this._themeService.getColorThemes()
    this._colorThemeSchemaHandle?.dispose()
    this._colorThemeSchemaHandle = this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'workbench.colorTheme.themes',
        properties: {
          'workbench.colorTheme': {
            type: 'string',
            default: DEFAULT_DARK_COLOR_THEME_ID,
            enum: themes.map((t) => t.settingsId),
            enumItemLabels: Object.fromEntries(themes.map((t) => [t.settingsId, t.label])),
            description: localize(
              'settings.workbench.colorTheme.description',
              'Workbench color theme.',
            ),
          },
        },
      }),
    )
  }
}
