/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wires the TextMate service into monaco once the editor package is loaded.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IThemeService, type IWorkbenchContribution } from '@universe-editor/platform'
import { ITextMateService } from '../services/textmate/textMateService.js'
import { toTextMateRawTheme } from '../services/textmate/textMateThemeBridge.js'
import type { ColorThemeData } from '../services/themes/colorThemeData.js'
import type { WorkbenchThemeService } from '../services/themes/workbenchThemeService.js'
import { MonacoLoader } from '../workbench/editor/monaco/MonacoLoader.js'

/**
 * Initializes the TextMate tokenization engine against monaco's
 * TokenizationRegistry. We must NOT force monaco to load (that would pull the
 * multi-MB chunk into startup): models created before our factories register
 * simply tokenize with the Monarch fallback, and registering our factory
 * afterwards swaps them over automatically (the registry fires a change that
 * re-tokenizes open models). So we initialize when monaco signals "loaded"
 * (its actions bridge completes) or immediately if it already is.
 *
 * Also the theme bridge (VSCode `TextMateTokenizationFeature._updateTheme`):
 * forwards the color theme's TextMate rules + color map into the textmate
 * registry. `ITextMateService.setTheme` queues the theme until initialize()
 * ran, so the initial apply here is safe before monaco loads.
 */
export class TextMateContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @ITextMateService private readonly _textMateService: ITextMateService,
    @IThemeService private readonly _themeService: IThemeService,
  ) {
    super()
    this._applyTheme()
    this._register(this._themeService.onDidColorThemeChange(() => this._applyTheme()))

    if (MonacoLoader.peek() !== undefined) {
      void this._textMateService.initialize(MonacoLoader.get())
      return
    }
    this._register(
      MonacoLoader.onDidBridgeActions(() => {
        void this._textMateService.initialize(MonacoLoader.get())
      }),
    )
  }

  private _applyTheme(): void {
    const themeService = this._themeService as WorkbenchThemeService
    const themeData: ColorThemeData = themeService.getColorThemeData()
    this._textMateService.setTheme(toTextMateRawTheme(themeData), themeData.tokenColorMap)
  }
}
