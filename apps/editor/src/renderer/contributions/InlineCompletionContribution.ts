/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  InlineCompletionContribution — once Monaco is ready, registers a single inline
 *  completions provider for all languages that delegates to IInlineCompletionService.
 *  Mirrors JsonLanguageFeaturesContribution's lazy-after-Monaco registration shape.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, type IWorkbenchContribution } from '@universe-editor/platform'
import { ILanguageFeaturesService } from '../services/languageFeatures/LanguageFeaturesService.js'
import { IInlineCompletionService } from '../services/ai/InlineCompletionService.js'
import { MonacoLoader, type monaco } from '../workbench/editor/monaco/MonacoLoader.js'

export class InlineCompletionContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @ILanguageFeaturesService languageFeatures: ILanguageFeaturesService,
    @IInlineCompletionService inlineCompletion: IInlineCompletionService,
  ) {
    super()

    void MonacoLoader.ensureInitialized().then(() => {
      if (this._store.isDisposed) return
      const provider: monaco.languages.InlineCompletionsProvider = {
        provideInlineCompletions: (model, position, context, token) =>
          // Monaco's CancellationToken and platform's are structurally identical
          // but nominally distinct types; bridge across the boundary.
          inlineCompletion
            .provide(model, position, context, token as never)
            .then((r) => r ?? undefined),
        disposeInlineCompletions: () => {
          // No per-completion resources to release.
        },
      }
      this._register(languageFeatures.registerInlineCompletionsProvider('*', provider))
    })
  }
}
