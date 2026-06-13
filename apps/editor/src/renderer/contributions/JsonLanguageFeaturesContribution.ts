/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  JsonLanguageFeaturesContribution — registers a JSON document-symbol provider
 *  with ILanguageFeaturesService so the workbench Outline view, breadcrumbs and
 *  "Go to Symbol in File" (Ctrl+Shift+O) light up for `.json` files.
 *
 *  Everything else for JSON (syntax highlighting, formatting, schema-driven
 *  completion / hover / validation) is already served by Monaco's built-in JSON
 *  worker. Document symbols are the one gap: the OutlineService only enumerates
 *  providers registered through ILanguageFeaturesService, and Monaco's own JSON
 *  symbol provider isn't one of them (its `documentSymbols` mode flag stays OFF
 *  in MonacoLoader). Rather than spin up a separate language service, we register
 *  a thin provider that delegates to that same worker via `monaco.json.getWorker`
 *  and reuses the shared LSP→Monaco symbol converter.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, type IWorkbenchContribution } from '@universe-editor/platform'
import type { DocumentSymbol, SymbolInformation } from 'vscode-languageserver-types'
import { ILanguageFeaturesService } from '../services/languageFeatures/LanguageFeaturesService.js'
import { MonacoLoader, type monaco } from '../workbench/editor/monaco/MonacoLoader.js'
import { documentSymbolsToMonaco } from '../services/languageFeatures/typescript/lspMonacoConvert.js'

/** Subset of the runtime JSON worker we use; the public IJSONWorker type omits it. */
interface JsonSymbolWorker {
  findDocumentSymbols(uri: string): Promise<DocumentSymbol[] | SymbolInformation[]>
}

export class JsonLanguageFeaturesContribution extends Disposable implements IWorkbenchContribution {
  constructor(@ILanguageFeaturesService languageFeatures: ILanguageFeaturesService) {
    super()

    void MonacoLoader.ensureInitialized().then((m) => {
      if (this._store.isDisposed) return
      this._register(
        languageFeatures.registerDocumentSymbolProvider('json', {
          displayName: 'JSON',
          provideDocumentSymbols: (model) => this._provideDocumentSymbols(m, model),
        }),
      )
    })
  }

  private async _provideDocumentSymbols(
    m: typeof monaco,
    model: monaco.editor.ITextModel,
  ): Promise<monaco.languages.DocumentSymbol[]> {
    const getWorker = await m.json.getWorker()
    const worker = (await getWorker(model.uri)) as unknown as JsonSymbolWorker
    if (model.isDisposed()) return []
    const symbols = await worker.findDocumentSymbols(model.uri.toString())
    return documentSymbolsToMonaco(symbols)
  }
}
