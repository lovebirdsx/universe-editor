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
  IHostService,
  ILoggerService,
  isDark,
  mark,
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
  type ISetColorThemeOptions,
  type IThemeService,
} from '@universe-editor/platform'
import type {
  IIconThemeContribution as IManifestIconThemeContribution,
  IProductIconThemeContribution as IManifestProductIconThemeContribution,
  IThemeContribution as IManifestThemeContribution,
} from '@universe-editor/extensions-common'
import { PerfMarks } from '../../../shared/perf/marks.js'
import { ColorThemeData } from './colorThemeData.js'
import { FileIconThemeData } from './fileIconThemeData.js'
import { generateColorThemeCSS } from './generateColorThemeCss.js'
import { ProductIconThemeData } from './productIconThemeData.js'
import { ExtensionThemeRegistry } from './themeRegistry.js'
import {
  DEFAULT_DARK_COLOR_THEME_ID,
  DEFAULT_LIGHT_COLOR_THEME_ID,
  ThemeConfiguration,
  ThemeSettings,
  type IHostColorScheme,
} from './themeConfiguration.js'

const SNAPSHOT_STORAGE_KEY = 'universe.theme.cssSnapshot'
const FILE_ICON_SNAPSHOT_STORAGE_KEY = 'universe.theme.fileIconSnapshot'

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

/** 图标主题的注册上下文与颜色主题共用（同一扩展点调用形态）。 */
export type IIconThemeRegistrationContext = IColorThemeRegistrationContext

/** 图标主题 URL 转换器：把扩展内的绝对资源 URI 转成 renderer 可加载的 URL
 * （universe-app 资源 URL）。由 ThemesContribution 接线时注入。 */
export type IconResourceUrlResolver = (resource: URI) => string

function schemeToDataset(scheme: ColorScheme): 'dark' | 'light' {
  return scheme === ColorScheme.LIGHT || scheme === ColorScheme.HIGH_CONTRAST_LIGHT
    ? 'light'
    : 'dark'
}

export class WorkbenchThemeService extends Disposable implements IThemeService {
  declare readonly _serviceBrand: undefined

  private readonly _colorThemeRegistry: ExtensionThemeRegistry<ColorThemeData>
  private readonly _fileIconThemeRegistry: ExtensionThemeRegistry<FileIconThemeData>
  private readonly _productIconThemeRegistry: ExtensionThemeRegistry<ProductIconThemeData>
  private _currentColorTheme: ColorThemeData
  private _currentFileIconTheme: FileIconThemeData
  private _currentProductIconTheme: ProductIconThemeData
  private _themeChain: Promise<unknown> = Promise.resolve()
  private _applyToken = 0
  private _themeStyleElement: HTMLStyleElement | undefined
  private _fileIconStyleElement: HTMLStyleElement | undefined
  private _productIconStyleElement: HTMLStyleElement | undefined
  private readonly _themeConfiguration: ThemeConfiguration
  private readonly _logger: ILogger
  private _iconResourceUrlResolver: IconResourceUrlResolver | undefined
  private readonly _hostColorScheme: IHostColorScheme
  private readonly _hostColorSchemeEmitter: Emitter<boolean>

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
    @IHostService private readonly _hostService: IHostService,
  ) {
    super()
    this._logger = loggerService?.createLogger({ id: 'theme', name: 'Theme' }) ?? new NullLogger()
    // 系统配色缓存：IPC 事件推进，初值异步拉取（拉到前按暗色处理——内置默认即
    // 暗色主题）。VSCode IHostColorSchemeService 的对等物，无高对比度维度。
    const hostEmitter = this._register(new Emitter<boolean>())
    this._hostColorSchemeEmitter = hostEmitter
    this._hostColorScheme = { dark: true, onDidChange: hostEmitter.event }
    void this._hostService.isDarkColorScheme().then((dark) => {
      if (dark !== this._hostColorScheme.dark) {
        this._hostColorScheme.dark = dark
        this._hostColorSchemeEmitter.fire(dark)
      }
    })
    this._register(
      this._hostService.onDidChangeColorScheme((dark) => {
        this._hostColorScheme.dark = dark
        this._hostColorSchemeEmitter.fire(dark)
      }),
    )
    this._themeConfiguration = new ThemeConfiguration(
      _configurationService,
      this._hostColorScheme,
      (settingsId) => this._colorThemeRegistry.findThemeBySettingsId(settingsId),
    )
    this._colorThemeRegistry = new ExtensionThemeRegistry<ColorThemeData>(undefined, (theme) =>
      this._logger.warn(`duplicate theme id replaced: ${theme.id}`),
    )
    this._fileIconThemeRegistry = new ExtensionThemeRegistry<FileIconThemeData>(
      undefined,
      (theme) => this._logger.warn(`duplicate file icon theme id replaced: ${theme.id}`),
    )
    this._productIconThemeRegistry = new ExtensionThemeRegistry<ProductIconThemeData>(
      undefined,
      (theme) => this._logger.warn(`duplicate product icon theme id replaced: ${theme.id}`),
    )
    // Before initialize() lands the real theme, hold an unloaded default so
    // getColor() consumers (snapshot CSS already covers painting) never crash.
    this._currentColorTheme = ColorThemeData.createUnloadedTheme(
      DEFAULT_DARK_COLOR_THEME_ID,
      ColorScheme.DARK,
    )
    this._currentFileIconTheme = FileIconThemeData.noIconTheme
    this._currentProductIconTheme = ProductIconThemeData.defaultTheme
    this._register(
      this._colorThemeRegistry.onDidChangeThemes(() => this._onDidChangeColorThemes.fire()),
    )
    this._register(
      this._fileIconThemeRegistry.onDidChangeThemes(() => this._onDidChangeFileIconThemes.fire()),
    )
    this._register(
      this._productIconThemeRegistry.onDidChangeThemes(() =>
        this._onDidChangeProductIconThemes.fire(),
      ),
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

  // ------------------------------------------------------------------ icon theme registration

  /**
   * Register `contributes.iconThemes` entries (called by the extension
   * translator). Paths resolve against the extension root; returns a disposable
   * that deregisters the whole batch.
   */
  registerFileIconThemes(
    contributions: readonly IManifestIconThemeContribution[],
    context: IIconThemeRegistrationContext,
  ): IDisposable {
    const registered: FileIconThemeData[] = []
    for (const contribution of contributions) {
      const location = URI.joinPath(URI.file(context.extensionLocation), contribution.path)
      const theme = FileIconThemeData.fromExtensionTheme(contribution, location, {
        extensionId: context.extensionId,
        extensionIsBuiltin: context.extensionIsBuiltin,
      })
      registered.push(theme)
      this._logger.debug(
        `registered file icon theme "${theme.settingsId}" (${theme.id}) from ${context.extensionId}`,
      )
    }
    this._fileIconThemeRegistry.registerThemes(registered)
    return {
      dispose: () => {
        this._fileIconThemeRegistry.deregisterThemes(registered)
      },
    }
  }

  /**
   * Register `contributes.productIconThemes` entries (called by the extension
   * translator).
   */
  registerProductIconThemes(
    contributions: readonly IManifestProductIconThemeContribution[],
    context: IIconThemeRegistrationContext,
  ): IDisposable {
    const registered: ProductIconThemeData[] = []
    for (const contribution of contributions) {
      const location = URI.joinPath(URI.file(context.extensionLocation), contribution.path)
      const theme = ProductIconThemeData.fromExtensionTheme(contribution, location, {
        extensionId: context.extensionId,
        extensionIsBuiltin: context.extensionIsBuiltin,
      })
      registered.push(theme)
      this._logger.debug(
        `registered product icon theme "${theme.settingsId}" (${theme.id}) from ${context.extensionId}`,
      )
    }
    this._productIconThemeRegistry.registerThemes(registered)
    return {
      dispose: () => {
        this._productIconThemeRegistry.deregisterThemes(registered)
      },
    }
  }

  getFileIconThemes(): FileIconThemeData[] {
    return [...this._fileIconThemeRegistry.getThemes()]
  }

  getProductIconThemes(): ProductIconThemeData[] {
    return [...this._productIconThemeRegistry.getThemes()]
  }

  /** Fires when the set of registered file icon themes changes. */
  private readonly _onDidChangeFileIconThemes = this._register(new Emitter<void>())
  readonly onDidChangeFileIconThemes: Event<void> = this._onDidChangeFileIconThemes.event

  /** Fires when the set of registered product icon themes changes. */
  private readonly _onDidChangeProductIconThemes = this._register(new Emitter<void>())
  readonly onDidChangeProductIconThemes: Event<void> = this._onDidChangeProductIconThemes.event

  /** Wire the universe-app resource URL mapper for icon theme assets (fonts/images). */
  setIconResourceUrlResolver(resolver: IconResourceUrlResolver): void {
    this._iconResourceUrlResolver = resolver
  }

  private _resolveIconResourceUrl(resource: URI): string {
    return this._iconResourceUrlResolver?.(resource) ?? resource.fsPath
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
        if (
          e.affectsConfiguration(ThemeSettings.COLOR_THEME) ||
          e.affectsConfiguration(ThemeSettings.PREFERRED_DARK_THEME) ||
          e.affectsConfiguration(ThemeSettings.PREFERRED_LIGHT_THEME) ||
          e.affectsConfiguration(ThemeSettings.DETECT_COLOR_SCHEME)
        ) {
          // COLOR_THEME 之外的三键都在系统跟随链路上（VSCode restoreColorTheme
          // 的对等处理）：preferred 值变化且当前 scheme 命中、或跟随开关翻转，
          // 都要按「当前活动设置键」重取主题。
          void this.setColorTheme(this._themeConfiguration.colorTheme)
        } else if (e.affectsConfiguration(ThemeSettings.COLOR_CUSTOMIZATIONS)) {
          void this._enqueue(async () => {
            this._applyCustomizationsToCurrentTheme()
            this._applyCurrentTheme()
          })
        } else if (e.affectsConfiguration(ThemeSettings.FILE_ICON_THEME)) {
          void this.setFileIconTheme(this._themeConfiguration.fileIconTheme)
        } else if (e.affectsConfiguration(ThemeSettings.PRODUCT_ICON_THEME)) {
          void this.setProductIconTheme(this._themeConfiguration.productIconTheme)
        }
      }),
    )
    // 系统暗/亮切换：仅跟随开启时重取（VSCode installPreferredSchemeListener）。
    let previousDark = this._hostColorScheme.dark
    this._register(
      this._hostColorScheme.onDidChange(() => {
        const darkChanged = previousDark !== this._hostColorScheme.dark
        previousDark = this._hostColorScheme.dark
        if (darkChanged && this._themeConfiguration.isDetectingColorScheme()) {
          this._logger.info(
            `system color scheme changed to ${this._hostColorScheme.dark ? 'dark' : 'light'}; re-applying preferred theme`,
          )
          void this.setColorTheme(this._themeConfiguration.colorTheme)
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
    } else {
      this._logger.debug('no themes registered yet; deferring initial theme application')
      const waiter = this._colorThemeRegistry.onDidChangeThemes(() => {
        if (this.getColorThemes().length > 0) {
          waiter.dispose()
          void this.setColorTheme(this._themeConfiguration.colorTheme)
        }
      })
      this._register(waiter)
    }

    // Icon themes ride the same deferred-application pattern: extension
    // translation lands after initialize() (Eventually phase), so when the
    // user configured a contributed icon theme, wait for the first
    // registration batch before applying it. The default value is null
    // (noIconTheme, shown as "Universe Material" — rendered programmatically
    // with the built-in Material SVGs) and applies immediately.
    const configuredFileIconTheme = this._themeConfiguration.fileIconTheme
    if (configuredFileIconTheme === null || this.getFileIconThemes().length > 0) {
      await this.setFileIconTheme(configuredFileIconTheme)
    } else {
      const fileIconWaiter = this._fileIconThemeRegistry.onDidChangeThemes(() => {
        if (this.getFileIconThemes().length > 0) {
          fileIconWaiter.dispose()
          void this.setFileIconTheme(this._themeConfiguration.fileIconTheme)
        }
      })
      this._register(fileIconWaiter)
    }
    const configuredProductIconTheme = this._themeConfiguration.productIconTheme
    await this.setProductIconTheme(configuredProductIconTheme)
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
    return this._currentFileIconTheme
  }

  /** Current file icon theme as the concrete data type (internal consumers). */
  getFileIconThemeData(): FileIconThemeData {
    return this._currentFileIconTheme
  }

  getProductIconTheme(): IProductIconTheme {
    return this._currentProductIconTheme
  }

  /** Current product icon theme as the concrete data type (internal consumers). */
  getProductIconThemeData(): ProductIconThemeData {
    return this._currentProductIconTheme
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
        // VSCode 同款：跟随系统时写到当前 scheme 的 preferred 设置键。
        this._configurationService.update(
          this._themeConfiguration.getColorThemeSettingId(),
          theme.settingsId,
          ConfigurationTarget.User,
        )
      }
      return theme
    })
  }

  getPreferredColorScheme(): ColorScheme | undefined {
    return this._themeConfiguration.getPreferredColorScheme()
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

  // ------------------------------------------------------------------ file icon themes

  /**
   * Apply a file icon theme by settingsId or full theme id; serialized through
   * the same promise chain as color themes. `null` / `undefined` select
   * noIconTheme (the default, shown as "Universe Material" — rendered
   * programmatically with the built-in Material SVGs); an unknown id also
   * falls back to `noIconTheme`.
   * Does not persist configuration — the settings subscription / picker accept
   * path owns that.
   */
  setFileIconTheme(
    themeIdOrSettingsId: string | null | undefined,
  ): Promise<FileIconThemeData | undefined> {
    return this._enqueue(async () => {
      const theme = this._findFileIconTheme(themeIdOrSettingsId)
      if (theme === this._currentFileIconTheme && theme.isLoaded) {
        return theme
      }
      const token = ++this._applyToken
      try {
        await theme.ensureLoaded(
          (uri) => this._fileService.readFileText(uri),
          (resource) => this._resolveIconResourceUrl(resource),
        )
      } catch (err) {
        this._logger.error(
          `failed to load file icon theme ${theme.settingsId}: ${(err as Error).message}`,
        )
        return undefined
      }
      if (token !== this._applyToken) {
        return undefined
      }
      this._currentFileIconTheme = theme
      this._applyFileIconTheme()
      return theme
    })
  }

  private _findFileIconTheme(idOrSettingsId: string | null | undefined): FileIconThemeData {
    if (idOrSettingsId === null || idOrSettingsId === undefined) {
      return FileIconThemeData.noIconTheme
    }
    const theme =
      this._fileIconThemeRegistry.findThemeBySettingsId(idOrSettingsId) ??
      this._fileIconThemeRegistry.findThemeById(idOrSettingsId)
    return theme ?? FileIconThemeData.noIconTheme
  }

  private _applyFileIconTheme(): void {
    const theme = this._currentFileIconTheme
    this._injectFileIconCss(theme.styleSheetContent ?? '')
    this._writeFileIconSnapshot(theme)
    this._logger.info(`applied file icon theme: ${theme.settingsId ?? '<none>'} (${theme.id})`)
    this._onDidFileIconThemeChange.fire(theme)
  }

  private _injectFileIconCss(css: string): void {
    if (this._fileIconStyleElement === undefined) {
      const style = document.createElement('style')
      style.type = 'text/css'
      style.className = 'contributedFileIconTheme'
      document.head.appendChild(style)
      this._fileIconStyleElement = style
    }
    this._fileIconStyleElement.textContent = css
  }

  private _writeFileIconSnapshot(theme: FileIconThemeData): void {
    try {
      globalThis.localStorage?.setItem(
        FILE_ICON_SNAPSHOT_STORAGE_KEY,
        JSON.stringify(theme.toStorageSnapshot()),
      )
    } catch {
      // localStorage may be unavailable; theming still works.
    }
  }

  /**
   * Synchronously inject the file icon CSS persisted by the previous session.
   * Same anti-flicker rationale as {@link restoreSnapshot}; idempotent.
   */
  restoreFileIconSnapshot(): void {
    try {
      const raw = globalThis.localStorage?.getItem(FILE_ICON_SNAPSHOT_STORAGE_KEY)
      if (!raw) {
        return
      }
      const parsed = JSON.parse(raw) as { styleSheetContent?: string }
      if (typeof parsed.styleSheetContent === 'string' && parsed.styleSheetContent.length > 0) {
        this._injectFileIconCss(parsed.styleSheetContent)
      }
    } catch {
      // Ignore malformed snapshots.
    }
  }

  /** Reload the current file icon theme from disk and re-apply (file watcher). */
  reloadCurrentFileIconTheme(): Promise<void> {
    return this._enqueue(async () => {
      const theme = this._currentFileIconTheme
      if (theme.location === undefined) {
        return
      }
      this._logger.info(`reloading file icon theme from disk: ${theme.settingsId}`)
      try {
        await theme.reload(
          (uri) => this._fileService.readFileText(uri),
          (resource) => this._resolveIconResourceUrl(resource),
        )
      } catch (err) {
        this._logger.error(
          `failed to reload file icon theme ${theme.settingsId}: ${(err as Error).message}`,
        )
        return
      }
      this._applyFileIconTheme()
    })
  }

  // ------------------------------------------------------------------ product icon themes

  /**
   * Apply a product icon theme by settingsId or full theme id; `undefined` /
   * unknown ids fall back to the default (built-in codicons, no stylesheet).
   */
  setProductIconTheme(
    themeIdOrSettingsId: string | undefined,
  ): Promise<ProductIconThemeData | undefined> {
    return this._enqueue(async () => {
      const theme = this._findProductIconTheme(themeIdOrSettingsId)
      if (theme === this._currentProductIconTheme && theme.isLoaded) {
        return theme
      }
      const token = ++this._applyToken
      try {
        await theme.ensureLoaded((uri) => this._fileService.readFileText(uri))
      } catch (err) {
        this._logger.error(
          `failed to load product icon theme ${theme.settingsId}: ${(err as Error).message}`,
        )
        return undefined
      }
      if (token !== this._applyToken) {
        return undefined
      }
      this._currentProductIconTheme = theme
      this._applyProductIconTheme()
      return theme
    })
  }

  private _findProductIconTheme(idOrSettingsId: string | undefined): ProductIconThemeData {
    const theme =
      this._productIconThemeRegistry.findThemeBySettingsId(idOrSettingsId ?? undefined) ??
      this._productIconThemeRegistry.findThemeById(idOrSettingsId)
    return theme ?? ProductIconThemeData.defaultTheme
  }

  private _applyProductIconTheme(): void {
    const theme = this._currentProductIconTheme
    theme.buildStyleSheet((location) => this._resolveIconResourceUrlString(location))
    this._injectProductIconCss(theme.styleSheetContent ?? '')
    this._logger.info(`applied product icon theme: ${theme.settingsId} (${theme.id})`)
    this._onDidProductIconThemeChange.fire(theme)
  }

  private _resolveIconResourceUrlString(location: string): string {
    try {
      return this._resolveIconResourceUrl(URI.parse(location))
    } catch {
      return location
    }
  }

  private _injectProductIconCss(css: string): void {
    if (this._productIconStyleElement === undefined) {
      const style = document.createElement('style')
      style.type = 'text/css'
      style.className = 'contributedProductIconTheme'
      document.head.appendChild(style)
      this._productIconStyleElement = style
    }
    this._productIconStyleElement.textContent = css
  }

  /** Reload the current product icon theme from disk and re-apply (file watcher). */
  reloadCurrentProductIconTheme(): Promise<void> {
    return this._enqueue(async () => {
      const theme = this._currentProductIconTheme
      if (theme.location === undefined) {
        return
      }
      this._logger.info(`reloading product icon theme from disk: ${theme.settingsId}`)
      try {
        await theme.reload((uri) => this._fileService.readFileText(uri))
      } catch (err) {
        this._logger.error(
          `failed to reload product icon theme ${theme.settingsId}: ${(err as Error).message}`,
        )
        return
      }
      this._applyProductIconTheme()
    })
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
    mark(PerfMarks.rendererDidApplyColorTheme)
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
