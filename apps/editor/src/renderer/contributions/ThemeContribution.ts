/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IConfigurationService,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { MonacoLoader } from '../workbench/editor/monaco/MonacoLoader.js'

type WorkbenchColorTheme = 'dark' | 'light'

function getWorkbenchColorTheme(config: IConfigurationService): WorkbenchColorTheme {
  return config.get<string>('workbench.colorTheme') === 'light' ? 'light' : 'dark'
}

function getMonacoTheme(theme: WorkbenchColorTheme): 'vs' | 'vs-dark' {
  return theme === 'light' ? 'vs' : 'vs-dark'
}

export class ThemeContribution extends Disposable implements IWorkbenchContribution {
  constructor(@IConfigurationService private readonly _configuration: IConfigurationService) {
    super()

    this._applyTheme()
    this._register(
      this._configuration.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('workbench.colorTheme')) this._applyTheme()
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
      MonacoLoader.get().editor.setTheme(getMonacoTheme(theme))
    } catch {
      // Monaco is lazy-loaded by FileEditor; initial editor creation reads the same setting.
    }
  }
}
