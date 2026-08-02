/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * ThemesContribution（BlockStartup）—— 主题系统的装配点：
 * - 触发 WorkbenchThemeService.initialize（等扩展主题注册后应用配置主题）；
 * - 挂载 Monaco 主题桥（全局 Monaco 主题唯一事实源）与主题文件 watcher（热更新）；
 * - 维护 `workbench.colorTheme` / `workbench.iconTheme` / `workbench.productIconTheme`
 *   配置 schema 的动态 enum（跟随主题注册表，对等 VSCode 的
 *   updateColorThemeConfigurationSchemas 等）；
 * - 给图标主题资产接线 universe-app 资源 URL 转换与扩展目录白名单授权；
 * - 登记 codicon 图标库（产品图标主题按 id 覆盖字形的前提）。
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
  registerCodicons,
  URI,
  type IDisposable,
  type ILogger,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { IOutOfWorkspaceWatchService } from '../services/files/outOfWorkspaceWatchService.js'
import { IResourceAccessService } from '../../shared/ipc/resourceAccessService.js'
import { toResourceUrl } from '../workbench/markdown/resourceUri.js'
import { initMonacoThemeBridge } from '../services/themes/monacoThemeBridge.js'
import { initMonacoSemanticThemeBridge } from '../services/themes/monacoSemanticThemeBridge.js'
import {
  DEFAULT_DARK_COLOR_THEME_ID,
  DEFAULT_LIGHT_COLOR_THEME_ID,
  ThemeSettings,
} from '../services/themes/themeConfiguration.js'
import { ThemeFileWatcher } from '../services/themes/themeFileWatcher.js'
import { registerUniverseColorIds } from '../services/themes/universeColorIds.js'
import type { WorkbenchThemeService } from '../services/themes/workbenchThemeService.js'

export class ThemesContribution extends Disposable implements IWorkbenchContribution {
  private readonly _logger: ILogger
  private _colorThemeSchemaHandle: IDisposable | undefined
  private _fileIconThemeSchemaHandle: IDisposable | undefined
  private _productIconThemeSchemaHandle: IDisposable | undefined

  constructor(
    @IThemeService private readonly _themeService: WorkbenchThemeService,
    @IConfigurationService private readonly _configurationService: IConfigurationService,
    @IFileWatcherService fileWatcherService: IFileWatcherService,
    @IOutOfWorkspaceWatchService outOfWorkspaceWatch: IOutOfWorkspaceWatchService,
    @ILoggerService loggerService: ILoggerService,
    @IResourceAccessService private readonly _resourceAccess: IResourceAccessService,
  ) {
    super()
    // The CSS generator and getColor() consumers resolve against this registry;
    // it must be populated before initialize() applies the first theme.
    registerUniverseColorIds()
    // Product icon themes resolve codicon ids against the icon registry.
    registerCodicons()
    this._logger = loggerService?.createLogger({ id: 'theme', name: 'Theme' }) ?? new NullLogger()
    this._register(initMonacoThemeBridge(_themeService, _configurationService, this._logger))
    this._register(
      initMonacoSemanticThemeBridge(_themeService, _configurationService, this._logger),
    )
    this._register(
      new ThemeFileWatcher(_themeService, fileWatcherService, outOfWorkspaceWatch, this._logger),
    )
    // Icon theme assets (SVG icons, fonts) are served through the universe-app
    // resource protocol; map absolute URIs to those URLs here.
    _themeService.setIconResourceUrlResolver((resource) => toResourceUrl(resource.fsPath))
    this._updateColorThemeSchema()
    this._updateFileIconThemeSchema()
    this._updateProductIconThemeSchema()
    this._register(this._themeService.onDidChangeColorThemes(() => this._updateColorThemeSchema()))
    this._register(
      this._themeService.onDidChangeFileIconThemes(() => this._updateFileIconThemeSchema()),
    )
    this._register(
      this._themeService.onDidChangeProductIconThemes(() => this._updateProductIconThemeSchema()),
    )
    // Allow the resource protocol to serve assets from any extension that
    // contributed an icon theme (their folders are outside the workspace).
    this._register(this._themeService.onDidChangeFileIconThemes(() => this._allowIconThemeRoots()))
    this._register(
      this._themeService.onDidChangeProductIconThemes(() => this._allowIconThemeRoots()),
    )
    void this._themeService.initialize()
  }

  override dispose(): void {
    this._colorThemeSchemaHandle?.dispose()
    this._fileIconThemeSchemaHandle?.dispose()
    this._productIconThemeSchemaHandle?.dispose()
    super.dispose()
  }

  private _allowIconThemeRoots(): void {
    const roots = new Set<string>()
    for (const theme of this._themeService.getFileIconThemes()) {
      if (theme.location !== undefined) {
        roots.add(URI.joinPath(theme.location, '..').fsPath)
      }
    }
    for (const theme of this._themeService.getProductIconThemes()) {
      if (theme.location !== undefined) {
        roots.add(URI.joinPath(theme.location, '..').fsPath)
      }
    }
    if (roots.size > 0) {
      void this._resourceAccess.allowRoots([...roots])
    }
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
          [ThemeSettings.PREFERRED_DARK_THEME]: {
            type: 'string',
            default: DEFAULT_DARK_COLOR_THEME_ID,
            enum: themes.map((t) => t.settingsId),
            enumItemLabels: Object.fromEntries(themes.map((t) => [t.settingsId, t.label])),
            description: localize(
              'settings.workbench.preferredDarkColorTheme.description',
              'Specifies the color theme when system color mode is dark and "window.autoDetectColorScheme" is enabled.',
            ),
          },
          [ThemeSettings.PREFERRED_LIGHT_THEME]: {
            type: 'string',
            default: DEFAULT_LIGHT_COLOR_THEME_ID,
            enum: themes.map((t) => t.settingsId),
            enumItemLabels: Object.fromEntries(themes.map((t) => [t.settingsId, t.label])),
            description: localize(
              'settings.workbench.preferredLightColorTheme.description',
              'Specifies the color theme when system color mode is light and "window.autoDetectColorScheme" is enabled.',
            ),
          },
          [ThemeSettings.DETECT_COLOR_SCHEME]: {
            type: 'boolean',
            default: false,
            description: localize(
              'settings.window.autoDetectColorScheme.description',
              'If enabled, will automatically select a color theme based on the system color mode. If the system color mode is dark, "workbench.preferredDarkColorTheme" is used, else "workbench.preferredLightColorTheme".',
            ),
          },
        },
      }),
    )
  }

  private _updateFileIconThemeSchema(): void {
    const themes = this._themeService.getFileIconThemes()
    this._fileIconThemeSchemaHandle?.dispose()
    this._fileIconThemeSchemaHandle = this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'workbench.iconTheme.themes',
        properties: {
          [ThemeSettings.FILE_ICON_THEME]: {
            type: ['string', 'null'],
            default: null,
            enum: [null, ...themes.map((t) => t.settingsId)],
            enumItemLabels: {
              null: 'Universe Material',
              ...Object.fromEntries(themes.map((t) => [t.settingsId ?? '', t.label])),
            },
            description: localize(
              'settings.workbench.iconTheme.description',
              'Specifies the file icon theme used in the workbench. `null` selects the built-in Universe Material icons.',
            ),
          },
        },
      }),
    )
  }

  private _updateProductIconThemeSchema(): void {
    const themes = this._themeService.getProductIconThemes()
    this._productIconThemeSchemaHandle?.dispose()
    this._productIconThemeSchemaHandle = this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'workbench.productIconTheme.themes',
        properties: {
          [ThemeSettings.PRODUCT_ICON_THEME]: {
            type: 'string',
            default: 'Default',
            enum: themes.map((t) => t.settingsId),
            enumItemLabels: Object.fromEntries(themes.map((t) => [t.settingsId, t.label])),
            description: localize(
              'settings.workbench.productIconTheme.description',
              'Specifies the product icon theme used in the workbench.',
            ),
          },
        },
      }),
    )
  }
}
