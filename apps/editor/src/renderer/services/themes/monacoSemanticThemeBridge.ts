/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Monaco 语义染色桥 —— 让 standalone 的 `SemanticTokensProviderStyling` 用上
 * VSCode 对等的语义打分模型。
 *
 * 背景（调研结论）：monaco standalone 的语义染色有两处与 VSCode 不对等——
 *
 * 1. `StandaloneTheme.semanticHighlighting` 硬编码 false（构造里赋值），导致
 *    默认 `editor.semanticHighlighting.enabled = configuredByTheme` 时
 *    `isSemanticColoringEnabled` 回退到主题标记恒为 false，语义染色永不开启。
 * 2. `StandaloneTheme.getTokenStyleMetadata` 走 `TokenTheme._match`（ThemeTrieElement
 *    最深节点完全胜出、同深度后插入按属性合并、无 `*` 通配、无 `:language` 限定、
 *    modifier 顺序敏感），语义与 VSCode 的逐属性 max-score 打分（见
 *    ColorThemeData.getSemanticTokenStyle）相差甚远。
 *
 * 解法（对齐 VSCode）：`StandaloneTheme` 类未被 monaco 导出，无法 `extends`。
 * 这里取活动主题的原型建一个子类（`Object.create(themeProto)`），只覆写两处——
 * `semanticHighlighting` 按 `editor.semanticHighlighting.enabled` 三态解析
 * （true/false 常量；configuredByTheme → ColorThemeData.semanticHighlighting），
 * `getTokenStyleMetadata` 委托 ColorThemeData 的完整打分。实例字段
 * （themeData/colors/_tokenTheme/defaultColors）逐字段从既有活动主题拷贝，
 * 因此 `tokenTheme` getter 不受影响（`_updateThemeOrColorMap` 仍读它生成 mtk CSS），
 * e2e 探针的 `getColorTheme().tokenTheme.getColorMap()` 同样读到同一份。
 *
 * 刷新语义：`_updateActualTheme` 对同实例 setTheme 有 `this._theme === desiredTheme`
 * 早退，因此换入新克隆后先对当前 `_theme` 调 `notifyBaseUpdated()` 失效缓存，
 * 再 `setTheme(name)` 触发完整 `_updateThemeOrColorMap`。
 *
 * 注入时序：monaco 的 `defineTheme` 会用全新原生实例覆盖 `_knownThemes[name]`，
 * 销毁先前注入的克隆。monacoThemeBridge 先于本 bridge 订阅 onDidColorThemeChange，
 * 其 applyTheme 把 defineTheme 包在 `ensureInitialized().then(...)` 里；本 bridge 的
 * rebuild 同样把注入包进 `ensureInitialized().then(...)`——同一个 promise 上后挂的
 * 续体排在后，注入因此恒在 defineTheme 之后执行，克隆不会被覆盖。
 */

import {
  DisposableStore,
  IConfigurationService,
  type IDisposable,
  type ILogger,
  NullLogger,
} from '@universe-editor/platform'
import type {
  IStandaloneThemeLike,
  ITokenStyleMetadataResult,
} from 'monaco-editor/esm/vs/editor/standalone/browser/standaloneThemeService.js'
import { MonacoLoader } from '../../workbench/editor/monaco/MonacoLoader.js'
import type { ColorThemeData } from './colorThemeData.js'
import { toMonacoThemeName } from './monacoThemeAdapter.js'
import type { WorkbenchThemeService } from './workbenchThemeService.js'

const SEMANTIC_HIGHLIGHTING_KEY = 'editor.semanticHighlighting.enabled'

type SemanticHighlightingSetting = boolean | 'configuredByTheme'

/** 三态解析：true/false 直接生效；configuredByTheme 回退主题的 semanticHighlighting。 */
function resolveSemanticHighlighting(
  setting: SemanticHighlightingSetting,
  theme: ColorThemeData,
): boolean {
  if (typeof setting === 'boolean') {
    return setting
  }
  return theme.semanticHighlighting
}

export function initMonacoSemanticThemeBridge(
  themeService: WorkbenchThemeService,
  configurationService: IConfigurationService,
  logger: ILogger = new NullLogger(),
): IDisposable {
  const disposables = new DisposableStore()

  void MonacoLoader.ensureInitialized().then(async () => {
    const { StandaloneServices } =
      await import('monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js')
    const { IStandaloneThemeService } =
      await import('monaco-editor/esm/vs/editor/standalone/common/standaloneTheme.js')

    const standaloneThemeService = StandaloneServices.get<{
      _knownThemes: Map<string, IStandaloneThemeLike>
      _theme: IStandaloneThemeLike
      setTheme: (name: string) => void
      getColorTheme: () => IStandaloneThemeLike
    }>(IStandaloneThemeService)

    const readSetting = (): SemanticHighlightingSetting => {
      const value = configurationService.get<SemanticHighlightingSetting>(SEMANTIC_HIGHLIGHTING_KEY)
      return value === undefined ? 'configuredByTheme' : value
    }

    const knownThemes = standaloneThemeService._knownThemes

    const rebuild = (): void => {
      // 同一 promise 上后挂的续体排在 monacoThemeBridge 的 defineTheme 之后，
      // 避免注入的克隆被 defineTheme 的原生实例覆盖（见文件头注释）。
      void MonacoLoader.ensureInitialized().then(() => {
        const colorTheme = themeService.getColorThemeData()
        const name = toMonacoThemeName(colorTheme.settingsId)
        const existing = knownThemes.get(name)
        if (!existing) {
          // monacoThemeBridge 尚未 defineTheme（首个编辑器创建前）；主题应用后
          // onDidColorThemeChange 会再次触发 rebuild。
          return
        }

        // 以既有主题为原型建语义子类实例，逐字段拷贝可写实例字段，
        // 覆写 semanticHighlighting 与 getTokenStyleMetadata。
        const semanticTheme = Object.create(
          Object.getPrototypeOf(existing),
        ) as IStandaloneThemeLike & {
          _colorThemeData: ColorThemeData
          colors: unknown
          defaultColors: unknown
          _tokenTheme: unknown
        }
        const src = existing as unknown as Record<string, unknown>
        for (const key of [
          'themeData',
          'id',
          'themeName',
          'colors',
          'defaultColors',
          '_tokenTheme',
        ]) {
          if (key in src) {
            ;(semanticTheme as unknown as Record<string, unknown>)[key] = src[key]
          }
        }
        semanticTheme._colorThemeData = colorTheme
        semanticTheme.semanticHighlighting = resolveSemanticHighlighting(readSetting(), colorTheme)
        semanticTheme.getTokenStyleMetadata = (
          type: string,
          modifiers: string[],
          modelLanguage: string,
        ): ITokenStyleMetadataResult | undefined => {
          const style = colorTheme.getTokenStyleMetadata(type, modifiers, modelLanguage)
          if (!style) {
            return undefined
          }
          return {
            foreground: style.foreground,
            italic: style.italic,
            bold: style.bold,
            underline: style.underline,
            strikethrough: style.strikethrough,
          }
        }

        knownThemes.set(name, semanticTheme)
        // 同实例 setTheme 会早退；先失效缓存再 setTheme 触发完整刷新。
        existing.notifyBaseUpdated?.()
        standaloneThemeService.setTheme(name)
        logger.debug(
          `monaco semantic theme rebuilt: ${name} (semanticHighlighting=${resolveSemanticHighlighting(
            readSetting(),
            colorTheme,
          )})`,
        )
      })
    }

    rebuild()
    disposables.add(themeService.onDidColorThemeChange(() => rebuild()))
    disposables.add(
      configurationService.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(SEMANTIC_HIGHLIGHTING_KEY)) {
          rebuild()
        }
      }),
    )
  })

  return disposables
}
