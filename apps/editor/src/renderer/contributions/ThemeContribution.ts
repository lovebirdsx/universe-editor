/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IConfigurationService,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { MonacoLoader } from '../workbench/editor/monaco/MonacoLoader.js'
import {
  defineOutputThemes,
  type LineHighlightOverrides,
} from '../workbench/panel/output/monacoLogLanguage.js'

type WorkbenchColorTheme = 'dark' | 'light'

function getWorkbenchColorTheme(config: IConfigurationService): WorkbenchColorTheme {
  return config.get<string>('workbench.colorTheme') === 'light' ? 'light' : 'dark'
}

function getMonacoTheme(theme: WorkbenchColorTheme): 'output-light' | 'output-dark' {
  return theme === 'light' ? 'output-light' : 'output-dark'
}

function getLineHighlightOverrides(config: IConfigurationService): LineHighlightOverrides {
  return {
    background: config.get<string>('editor.lineHighlightBackground') ?? '',
    border: config.get<string>('editor.lineHighlightBorder') ?? '',
  }
}

export class ThemeContribution extends Disposable implements IWorkbenchContribution {
  constructor(@IConfigurationService private readonly _configuration: IConfigurationService) {
    super()

    this._applyTheme()
    // Monaco is lazy-loaded by FileEditor; once it resolves, re-apply so any
    // user-configured line-highlight colors (read here, not in registerLogLanguage)
    // take effect on the global theme.
    void MonacoLoader.ensureInitialized().then(() => this._applyTheme())
    this._register(
      this._configuration.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('workbench.colorTheme') ||
          e.affectsConfiguration('editor.lineHighlightBackground') ||
          e.affectsConfiguration('editor.lineHighlightBorder')
        ) {
          this._applyTheme()
        }
      }),
    )
  }

  private _applyTheme(): void {
    const theme = getWorkbenchColorTheme(this._configuration)
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    this._applyMonacoThemeIfLoaded(theme)
  }

  private _applyMonacoThemeIfLoaded(theme: WorkbenchColorTheme): void {
    try {
      const m = MonacoLoader.get()
      defineOutputThemes(m, getLineHighlightOverrides(this._configuration))
      m.editor.setTheme(getMonacoTheme(theme))
    } catch {
      // Monaco not loaded yet; the ensureInitialized() callback re-applies once ready.
    }
  }
}
