/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  Adapted from Microsoft VSCode for Universe Editor.
 *  Source: https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/themes/browser/workbenchThemeService.ts
 *--------------------------------------------------------------------------------------------*/

/**
 * WorkbenchThemeService —— VSCode `WorkbenchThemeService` 的对等物（裁剪版）。
 *
 * 职责：
 * - 持有颜色主题注册表（`ExtensionThemeRegistry<ColorThemeData>`），扩展翻译层
 *   通过 {@link registerColorThemes} 把 `contributes.themes` 注册进来；
 * - `restoreSnapshot()` 在 React 挂载前同步注入上次的 CSS 快照（防首屏闪烁）；
 * - `initialize()` 在扩展翻译完成后按配置应用主题，并订阅配置/主题集变化；
 * - `setColorTheme` 走 Promise 链串行化 + 单调 token 丢弃陈旧应用；
 * - 应用 = 合成定制色 → 生成 `--vscode-*` CSS 注入 → dataset/theme → 写快照 →
 *   fire `onDidColorThemeChange`（Monaco / 终端 / Mermaid 等消费者由事件驱动）。
 */

import {
  Color,
  ColorScheme,
  ConfigurationTarget,
  Disposable,
  Emitter,
  IConfigurationService,
  IFileService,
  ILoggerService,
  isDark,
  NullLogger,
  ThemeTypeSelector,
  URI,
  type ColorIdentifier,
  type Event,
  type IColorTheme,
  type IDisposable,
  type IFileIconTheme,
  type ILogger,
  type IProductIconTheme,
  type IThemeService,
} from '@universe-editor/platform'
import type { IThemeContribution as IManifestThemeContribution } from '@universe-editor/extensions-common'
import { ColorThemeData } from './colorThemeData.js'
import { generateColorThemeCSS } from './generateColorThemeCss.js'
import { ExtensionThemeRegistry } from './themeRegistry.js'
import {
  DEFAULT_DARK_COLOR_THEME_ID,
  DEFAULT_LIGHT_COLOR_THEME_ID,
  ThemeConfiguration,
  ThemeSettings,
} from './themeConfiguration.js'

const SNAPSHOT_STORAGE_KEY = 'universe.theme.cssSnapshot'

interface ICssSnapshot {
  css: string
  scheme: ColorScheme
  settingsId: string
}

export interface IColorThemeRegistrationContext {
  readonly extensionId: string
  /** Absolute path of the extension root (DTO `extensionLocation`). */
  readonly extensionLocation: string
  readonly extensionIsBuiltin: boolean
}

export interface ISetColorThemeOptions {
  /** Persist the choice to `workbench.colorTheme` (settingsId form). */
  readonly writeConfiguration?: boolean
}

// Phase 4 replaces these placeholders with real theme types.
const NO_FILE_ICON_THEME: IFileIconTheme = {
  id: '',
  label: '',
  settingsId: null,
  hasFileIcons: true,
  hasFolderIcons: true,
  hidesExplorerArrows: false,
}
const DEFAULT_PRODUCT_ICON_THEME: IProductIconTheme = {
  id: 'Default',
  label: 'Default',
  settingsId: 'Default',
  getIcon: () => undefined,
}

function schemeToDataset(scheme: ColorScheme): 'dark' | 'light' {
  return scheme === ColorScheme.LIGHT || scheme === ColorScheme.HIGH_CONTRAST_LIGHT
    ? 'light'
    : 'dark'
}

export class WorkbenchThemeService extends Disposable implements IThemeService {
  declare readonly _serviceBrand: undefined

  private readonly _colorThemeRegistry: ExtensionThemeRegistry<ColorThemeData>
  private _currentColorTheme: ColorThemeData
  private _themeChain: Promise<unknown> = Promise.resolve()
  private _applyToken = 0
  private _themeStyleElement: HTMLStyleElement | undefined
  private readonly _themeConfiguration: ThemeConfiguration
  private readonly _logger: ILogger

  private readonly _onDidColorThemeChange = this._register(new Emitter<IColorTheme>())
  readonly onDidColorThemeChange: Event<IColorTheme> = this._onDidColorThemeChange.event

  private readonly _onDidFileIconThemeChange = this._register(new Emitter<IFileIconTheme>())
  readonly onDidFileIconThemeChange: Event<IFileIconTheme> = this._onDidFileIconThemeChange.event

  private readonly _onDidProductIconThemeChange = this._register(new Emitter<IProductIconTheme>())
  readonly onDidProductIconThemeChange: Event<IProductIconTheme> =
    this._onDidProductIconThemeChange.event

  constructor(
    @IConfigurationService private readonly _configurationService: IConfigurationService,
    @IFileService private readonly _fileService: IFileService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService?.createLogger({ id: 'theme', name: 'Theme' }) ?? new NullLogger()
    this._themeConfiguration = new ThemeConfiguration(_configurationService)
    this._colorThemeRegistry = new ExtensionThemeRegistry<ColorThemeData>(undefined, (theme) =>
      this._logger.warn(`duplicate theme id replaced: ${theme.id}`),
    )
    // Before initialize() lands the real theme, hold an unloaded default so
    // getColor() consumers (snapshot CSS already covers painting) never crash.
    this._currentColorTheme = ColorThemeData.createUnloadedTheme(
      DEFAULT_DARK_COLOR_THEME_ID,
      ColorScheme.DARK,
    )
    this._register(
      this._colorThemeRegistry.onDidChangeThemes(() => this._onDidChangeColorThemes.fire()),
    )
  }

  // ------------------------------------------------------------------ snapshot

  /**
   * Synchronously inject the CSS snapshot persisted by the previous session so
   * the very first paint already uses the right colors. Idempotent. Must run
   * before React mounts (BlockRestore).
   */
  restoreSnapshot(): void {
    const snapshot = this._readSnapshot()
    if (snapshot === undefined) {
      return
    }
    this._logger.debug(`restoring theme snapshot: ${snapshot.settingsId}`)
    this._injectCss(snapshot.css)
    const restored = ColorThemeData.fromStorageSnapshot({
      id: `snapshot ${snapshot.settingsId}`,
      label: snapshot.settingsId,
      settingsId: snapshot.settingsId,
      type: snapshot.scheme,
      colorMap: {},
      tokenColors: [],
      semanticTokenColors: {},
      semanticHighlighting: false,
    })
    if (restored) {
      this._currentColorTheme = restored
    }
    this._updateDocumentThemeAttributes(snapshot.scheme)
  }

  private _readSnapshot(): ICssSnapshot | undefined {
    try {
      const raw = globalThis.localStorage?.getItem(SNAPSHOT_STORAGE_KEY)
      if (!raw) {
        return undefined
      }
      const parsed = JSON.parse(raw) as Partial<ICssSnapshot>
      if (typeof parsed.css !== 'string' || parsed.css.length === 0) {
        return undefined
      }
      return {
        css: parsed.css,
        scheme: parsed.scheme ?? ColorScheme.DARK,
        settingsId: typeof parsed.settingsId === 'string' ? parsed.settingsId : '',
      }
    } catch {
      return undefined
    }
  }

  private _writeSnapshot(css: string, theme: ColorThemeData): void {
    try {
      const snapshot: ICssSnapshot = {
        css,
        scheme: theme.type,
        settingsId: theme.settingsId,
      }
      globalThis.localStorage?.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot))
    } catch {
      // localStorage may be unavailable (quota / privacy mode); theming still works.
    }
  }

  // ------------------------------------------------------------------ registry

  /**
   * Register `contributes.themes` entries (called by the extension translator).
   * Contribution paths are resolved against the extension root. Returns a
   * disposable that deregisters the whole batch (translator rebuild).
   */
  registerColorThemes(
    contributions: readonly IManifestThemeContribution[],
    context: IColorThemeRegistrationContext,
  ): IDisposable {
    const registered: ColorThemeData[] = []
    for (const contribution of contributions) {
      const location = URI.joinPath(URI.file(context.extensionLocation), contribution.path)
      // Map the manifest DTO onto the loader's contribution shape explicitly:
      // its `uiTheme` is a string union while ThemeTypeSelector is an enum
      // (same value space), and exactOptionalPropertyTypes rejects passing
      // optional props through a spread.
      const theme = ColorThemeData.fromExtensionTheme(
        {
          ...(contribution.id !== undefined ? { id: contribution.id } : {}),
          ...(contribution.label !== undefined ? { label: contribution.label } : {}),
          ...(contribution.description !== undefined
            ? { description: contribution.description }
            : {}),
          uiTheme: contribution.uiTheme as ThemeTypeSelector,
          path: contribution.path,
        },
        location,
        {
          extensionId: context.extensionId,
          extensionIsBuiltin: context.extensionIsBuiltin,
        },
      )
      registered.push(theme)
      this._logger.debug(
        `registered color theme "${theme.settingsId}" (${theme.id}) from ${context.extensionId}`,
      )
    }
    // One extension's themes appear atomically (single registry event) so a
    // picker/schema waiting on the registry never sees a half-registered batch.
    this._colorThemeRegistry.registerThemes(registered)
    return {
      dispose: () => {
        this._colorThemeRegistry.deregisterThemes(registered)
      },
    }
  }

  getColorThemes(): ColorThemeData[] {
    return [...this._colorThemeRegistry.getThemes()]
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Apply the configured theme and subscribe to configuration / registry
   * changes. Idempotent. When the registry is still empty (extension
   * contributions not yet translated), the initial application is deferred to
   * the first registry change instead of falling back to the unloaded default.
   */
  async initialize(): Promise<void> {
    if (this._initialized) {
      return
    }
    this._initialized = true
    this._register(
      this._configurationService.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(ThemeSettings.COLOR_THEME)) {
          void this.setColorTheme(this._themeConfiguration.colorTheme)
        } else if (e.affectsConfiguration(ThemeSettings.COLOR_CUSTOMIZATIONS)) {
          void this._enqueue(async () => {
            this._applyCustomizationsToCurrentTheme()
            this._applyCurrentTheme()
          })
        }
      }),
    )
    this._register(
      this._colorThemeRegistry.onDidChangeThemes(() => {
        // The active theme went away (extension uninstalled): fall back to the
        // default for the current scheme.
        if (
          this._currentColorTheme.extensionData !== undefined &&
          !this._colorThemeRegistry.findThemeById(this._currentColorTheme.id)
        ) {
          this._logger.warn(
            `active theme ${this._currentColorTheme.settingsId} disappeared; falling back to default`,
          )
          const fallback = isDark(this._currentColorTheme.type)
            ? DEFAULT_DARK_COLOR_THEME_ID
            : DEFAULT_LIGHT_COLOR_THEME_ID
          void this.setColorTheme(fallback)
        }
      }),
    )
    if (this.getColorThemes().length > 0) {
      await this.setColorTheme(this._themeConfiguration.colorTheme)
      return
    }
    this._logger.debug('no themes registered yet; deferring initial theme application')
    const waiter = this._colorThemeRegistry.onDidChangeThemes(() => {
      if (this.getColorThemes().length > 0) {
        waiter.dispose()
        void this.setColorTheme(this._themeConfiguration.colorTheme)
      }
    })
    this._register(waiter)
  }

  private _initialized = false
  private readonly _onDidChangeColorThemes = this._register(new Emitter<void>())
  /** Fires when the set of registered color themes changes. */
  readonly onDidChangeColorThemes: Event<void> = this._onDidChangeColorThemes.event

  // ------------------------------------------------------------------ theme access

  getColorTheme(): IColorTheme {
    return this._currentColorTheme
  }

  /** Current theme as the concrete data type (internal consumers). */
  getColorThemeData(): ColorThemeData {
    return this._currentColorTheme
  }

  getColor(colorId: ColorIdentifier, useDefault?: boolean): Color | undefined {
    return this._currentColorTheme.getColor(colorId, useDefault)
  }

  getFileIconTheme(): IFileIconTheme {
    return NO_FILE_ICON_THEME
  }

  getProductIconTheme(): IProductIconTheme {
    return DEFAULT_PRODUCT_ICON_THEME
  }

  // ------------------------------------------------------------------ setColorTheme

  /**
   * Apply a theme by settingsId (e.g. `Universe Dark`) or full theme id.
   * Serialized through a promise chain; a stale application (superseded by a
   * newer request while loading) is discarded via a monotonic token.
   */
  setColorTheme(
    themeIdOrSettingsId: string | undefined,
    options: ISetColorThemeOptions = {},
  ): Promise<ColorThemeData | undefined> {
    return this._enqueue(async () => {
      const theme = this._findTheme(themeIdOrSettingsId)
      if (theme === undefined) {
        this._logger.warn(`theme not found: ${themeIdOrSettingsId ?? '<default>'}`)
        return undefined
      }
      const token = ++this._applyToken
      try {
        await theme.ensureLoaded((uri) => this._fileService.readFileText(uri))
      } catch (err) {
        this._logger.error(`failed to load theme ${theme.settingsId}: ${(err as Error).message}`)
        return undefined
      }
      if (token !== this._applyToken) {
        return undefined
      }
      this._currentColorTheme = theme
      this._applyCustomizationsToCurrentTheme()
      this._applyCurrentTheme()
      if (options.writeConfiguration === true) {
        this._configurationService.update(
          ThemeSettings.COLOR_THEME,
          theme.settingsId,
          ConfigurationTarget.User,
        )
      }
      return theme
    })
  }

  /**
   * Reload the current theme's document from disk and re-apply (theme file
   * watcher). No-op for synthetic (snapshot / unloaded) themes.
   */
  reloadCurrentTheme(): Promise<void> {
    return this._enqueue(async () => {
      const theme = this._currentColorTheme
      if (theme.location === undefined) {
        return
      }
      this._logger.info(`reloading theme from disk: ${theme.settingsId}`)
      try {
        await theme.reload((uri) => this._fileService.readFileText(uri))
      } catch (err) {
        this._logger.error(`failed to reload theme ${theme.settingsId}: ${(err as Error).message}`)
        return
      }
      this._applyCurrentTheme()
    })
  }

  private _findTheme(idOrSettingsId: string | undefined): ColorThemeData | undefined {
    const target = idOrSettingsId ?? DEFAULT_DARK_COLOR_THEME_ID
    return (
      this._colorThemeRegistry.findThemeBySettingsId(target, DEFAULT_DARK_COLOR_THEME_ID) ??
      this._colorThemeRegistry.findThemeById(target, DEFAULT_DARK_COLOR_THEME_ID)
    )
  }

  private _enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this._themeChain.then(fn, () => fn())
    this._themeChain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  // ------------------------------------------------------------------ applying

  private _applyCustomizationsToCurrentTheme(): void {
    const theme = this._currentColorTheme
    theme.setCustomColors(this._themeConfiguration.effectiveColorCustomizations(theme.settingsId))
  }

  private _applyCurrentTheme(): void {
    const theme = this._currentColorTheme
    const css = generateColorThemeCSS(theme)
    this._injectCss(css)
    this._updateDocumentThemeAttributes(theme.type)
    this._writeSnapshot(css, theme)
    this._logger.info(`applied color theme: ${theme.settingsId} (${theme.type})`)
    this._onDidColorThemeChange.fire(theme)
  }

  private _injectCss(css: string): void {
    if (this._themeStyleElement === undefined) {
      const style = document.createElement('style')
      style.type = 'text/css'
      style.className = 'contributedColorTheme'
      document.head.appendChild(style)
      this._themeStyleElement = style
    }
    this._themeStyleElement.textContent = css
  }

  private _updateDocumentThemeAttributes(scheme: ColorScheme): void {
    const value = schemeToDataset(scheme)
    document.documentElement.dataset.theme = value
    document.documentElement.style.colorScheme = value
  }
}
