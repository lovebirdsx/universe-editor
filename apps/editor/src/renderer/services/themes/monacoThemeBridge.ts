/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Monaco 主题桥 —— 全局 Monaco 主题的唯一事实源。
 *
 * 监听 WorkbenchThemeService 的主题变化，把 ColorThemeData 转成
 * IStandaloneThemeData（追加内置 log/markdown/semantic token 规则与
 * lineHighlight 覆盖）后 defineTheme + setTheme。Monaco 懒加载：
 * 每次应用都走 ensureInitialized（幂等），首个 FileEditor 触发加载后
 * 最近一次应用自然生效。per-editor `theme` option 一律不再设置。
 *
 * lineHighlight 三级：用户配置 > 主题 colors > OUTPUT_LINE_HIGHLIGHT 默认
 * （与迁移前 output-dark/output-light 主题保持一致）。
 */

import {
  DisposableStore,
  IConfigurationService,
  isDark,
  type IDisposable,
  type ILogger,
  NullLogger,
} from '@universe-editor/platform'
import {
  OUTPUT_LINE_HIGHLIGHT_DARK,
  OUTPUT_LINE_HIGHLIGHT_LIGHT,
} from '../configuration/fontDefaults.js'
import { MonacoLoader } from '../../workbench/editor/monaco/MonacoLoader.js'
import { getBuiltinTokenRules } from '../../workbench/panel/output/monacoLogLanguage.js'
import { normalizeColor, type ColorThemeData } from './colorThemeData.js'
import { toStandaloneThemeData } from './monacoThemeAdapter.js'
import type { WorkbenchThemeService } from './workbenchThemeService.js'

const LINE_HIGHLIGHT_KEYS = ['editor.lineHighlightBackground', 'editor.lineHighlightBorder']

export function initMonacoThemeBridge(
  themeService: WorkbenchThemeService,
  configurationService: IConfigurationService,
  logger: ILogger = new NullLogger(),
): IDisposable {
  const disposables = new DisposableStore()

  const applyTheme = (theme: ColorThemeData): void => {
    void MonacoLoader.ensureInitialized().then((m) => {
      const dark = isDark(theme.type)
      const defaults = dark ? OUTPUT_LINE_HIGHLIGHT_DARK : OUTPUT_LINE_HIGHLIGHT_LIGHT
      // 每级先归一化成 hex：用户配置写 rgba()/非法值时落到下一级，而不是把
      // Monaco 解析不了的字面量直通 defineTheme（fromHex 失败会静默退成纯红）。
      const configuredBackground = normalizeColor(
        configurationService.get<string>('editor.lineHighlightBackground'),
      )
      const configuredBorder = normalizeColor(
        configurationService.get<string>('editor.lineHighlightBorder'),
      )
      const themeBackground = normalizeColor(
        theme.getColor('editor.lineHighlightBackground', false),
      )
      const themeBorder = normalizeColor(theme.getColor('editor.lineHighlightBorder', false))
      const { name, data } = toStandaloneThemeData(theme, {
        lineHighlightBackground: configuredBackground ?? themeBackground ?? defaults.background,
        lineHighlightBorder: configuredBorder ?? themeBorder ?? defaults.border,
      })
      data.rules = [...data.rules, ...getBuiltinTokenRules(dark)]
      m.editor.defineTheme(name, data)
      m.editor.setTheme(name)
      logger.debug(`monaco theme applied: ${name}`)
    })
  }

  applyTheme(themeService.getColorThemeData())
  disposables.add(
    themeService.onDidColorThemeChange(() => applyTheme(themeService.getColorThemeData())),
  )
  disposables.add(
    configurationService.onDidChangeConfiguration((e) => {
      if (LINE_HIGHLIGHT_KEYS.some((key) => e.affectsConfiguration(key))) {
        applyTheme(themeService.getColorThemeData())
      }
    }),
  )
  return disposables
}
