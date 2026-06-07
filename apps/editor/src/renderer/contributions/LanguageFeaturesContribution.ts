/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers the built-in markdown language providers (document symbols,
 *  definition, references) with the language features facade once Monaco is
 *  loaded. Runs AfterRestore so the editor area — and Monaco — are in play.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, type IWorkbenchContribution } from '@universe-editor/platform'
import { MonacoLoader } from '../workbench/editor/monaco/MonacoLoader.js'
import { ILanguageFeaturesService } from '../services/languageFeatures/LanguageFeaturesService.js'
import { IMarkdownLanguageService } from '../../shared/ipc/markdownLanguageService.js'
import { MarkdownDocumentSymbolProvider } from '../services/languageFeatures/markdown/markdownDocumentSymbolProvider.js'
import { MarkdownDefinitionProvider } from '../services/languageFeatures/markdown/markdownDefinitionProvider.js'
import { MarkdownReferenceProvider } from '../services/languageFeatures/markdown/markdownReferenceProvider.js'

export class LanguageFeaturesContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @ILanguageFeaturesService private readonly _languageFeatures: ILanguageFeaturesService,
    @IMarkdownLanguageService private readonly _md: IMarkdownLanguageService,
  ) {
    super()
    // The facade forwards to monaco.languages.*, which requires Monaco loaded.
    void MonacoLoader.ensureInitialized().then(() => {
      if (this._store.isDisposed) return
      this._register(
        this._languageFeatures.registerDocumentSymbolProvider(
          'markdown',
          new MarkdownDocumentSymbolProvider(this._md),
        ),
      )
      this._register(
        this._languageFeatures.registerDefinitionProvider(
          'markdown',
          new MarkdownDefinitionProvider(this._md),
        ),
      )
      this._register(
        this._languageFeatures.registerReferenceProvider(
          'markdown',
          new MarkdownReferenceProvider(this._md),
        ),
      )
    })
  }
}
