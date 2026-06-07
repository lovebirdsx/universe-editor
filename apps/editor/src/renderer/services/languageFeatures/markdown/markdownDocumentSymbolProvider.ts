/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  DocumentSymbolProvider for markdown — a thin shell that forwards to the
 *  markdown language server and maps its DTOs to Monaco symbols. Drives both the
 *  Outline view and Monaco's built-in outline.
 *--------------------------------------------------------------------------------------------*/

import { type monaco } from '../../../workbench/editor/monaco/MonacoLoader.js'
import type { IMarkdownLanguageService } from '../../../../shared/ipc/markdownLanguageService.js'
import { mdSymbolToMonaco } from './lspMonacoConvert.js'

export class MarkdownDocumentSymbolProvider implements monaco.languages.DocumentSymbolProvider {
  readonly displayName = 'Markdown'

  constructor(private readonly _md: IMarkdownLanguageService) {}

  async provideDocumentSymbols(
    model: monaco.editor.ITextModel,
  ): Promise<monaco.languages.DocumentSymbol[]> {
    const symbols = await this._md.provideDocumentSymbols(model.uri)
    return symbols.map(mdSymbolToMonaco)
  }
}
