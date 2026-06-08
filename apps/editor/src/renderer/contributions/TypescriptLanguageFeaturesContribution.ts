/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers the TS/JS language providers (definition, references, implementation,
 *  type-definition, hover, completion, signature help, document symbols, rename)
 *  backed by the typescript-language-server, with the language features facade
 *  once Monaco is loaded. Runs AfterRestore so the editor area — and Monaco — are
 *  in play. Document sync + diagnostics live in TypescriptDocumentSyncContribution.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, type IWorkbenchContribution } from '@universe-editor/platform'
import { MonacoLoader } from '../workbench/editor/monaco/MonacoLoader.js'
import { ILanguageFeaturesService } from '../services/languageFeatures/LanguageFeaturesService.js'
import { ITypescriptLanguageService } from '../../shared/ipc/typescriptLanguageService.js'
import {
  TypescriptCompletionProvider,
  TypescriptDefinitionProvider,
  TypescriptDocumentSymbolProvider,
  TypescriptHoverProvider,
  TypescriptImplementationProvider,
  TypescriptReferenceProvider,
  TypescriptRenameProvider,
  TypescriptSignatureHelpProvider,
  TypescriptTypeDefinitionProvider,
} from '../services/languageFeatures/typescript/typescriptProviders.js'

const TS_JS_LANGUAGES = ['typescript', 'javascript', 'typescriptreact', 'javascriptreact']

export class TypescriptLanguageFeaturesContribution
  extends Disposable
  implements IWorkbenchContribution
{
  constructor(
    @ILanguageFeaturesService private readonly _languageFeatures: ILanguageFeaturesService,
    @ITypescriptLanguageService private readonly _ts: ITypescriptLanguageService,
  ) {
    super()
    // The facade forwards to monaco.languages.*, which requires Monaco loaded.
    void MonacoLoader.ensureInitialized().then(() => {
      if (this._store.isDisposed) return
      const definition = new TypescriptDefinitionProvider(this._ts)
      const reference = new TypescriptReferenceProvider(this._ts)
      const implementation = new TypescriptImplementationProvider(this._ts)
      const typeDefinition = new TypescriptTypeDefinitionProvider(this._ts)
      const hover = new TypescriptHoverProvider(this._ts)
      const completion = new TypescriptCompletionProvider(this._ts)
      const signatureHelp = new TypescriptSignatureHelpProvider(this._ts)
      const documentSymbol = new TypescriptDocumentSymbolProvider(this._ts)
      const rename = new TypescriptRenameProvider(this._ts)

      const lf = this._languageFeatures
      for (const lang of TS_JS_LANGUAGES) {
        this._register(lf.registerDefinitionProvider(lang, definition))
        this._register(lf.registerReferenceProvider(lang, reference))
        this._register(lf.registerImplementationProvider(lang, implementation))
        this._register(lf.registerTypeDefinitionProvider(lang, typeDefinition))
        this._register(lf.registerHoverProvider(lang, hover))
        this._register(lf.registerCompletionProvider(lang, completion))
        this._register(lf.registerSignatureHelpProvider(lang, signatureHelp))
        this._register(lf.registerDocumentSymbolProvider(lang, documentSymbol))
        this._register(lf.registerRenameProvider(lang, rename))
      }
    })
  }
}
