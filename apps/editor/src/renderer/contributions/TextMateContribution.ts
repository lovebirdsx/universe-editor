/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wires the TextMate service into monaco once the editor package is loaded.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, type IWorkbenchContribution } from '@universe-editor/platform'
import { ITextMateService } from '../services/textmate/textMateService.js'
import { MonacoLoader } from '../workbench/editor/monaco/MonacoLoader.js'

/**
 * Initializes the TextMate tokenization engine against monaco's
 * TokenizationRegistry. We must NOT force monaco to load (that would pull the
 * multi-MB chunk into startup): models created before our factories register
 * simply tokenize with the Monarch fallback, and registering our factory
 * afterwards swaps them over automatically (the registry fires a change that
 * re-tokenizes open models). So we initialize when monaco signals "loaded"
 * (its actions bridge completes) or immediately if it already is.
 */
export class TextMateContribution extends Disposable implements IWorkbenchContribution {
  constructor(@ITextMateService private readonly _textMateService: ITextMateService) {
    super()
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
}
