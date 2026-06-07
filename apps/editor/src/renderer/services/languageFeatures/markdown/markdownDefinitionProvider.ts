/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  DefinitionProvider for markdown — a thin shell that forwards to the markdown
 *  language server. Resolves both same-document `#anchor` links and cross-file
 *  `other.md#anchor` / `other.md` targets (the server walks the workspace).
 *  Cross-file targets are opened by MarkdownEditorOpenerContribution.
 *--------------------------------------------------------------------------------------------*/

import { MonacoLoader, type monaco } from '../../../workbench/editor/monaco/MonacoLoader.js'
import type { IMarkdownLanguageService } from '../../../../shared/ipc/markdownLanguageService.js'
import { mdLocationToMonaco, monacoPositionToMd } from './lspMonacoConvert.js'

export class MarkdownDefinitionProvider implements monaco.languages.DefinitionProvider {
  constructor(private readonly _md: IMarkdownLanguageService) {}

  async provideDefinition(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
  ): Promise<monaco.languages.Definition> {
    const locations = await this._md.provideDefinition(model.uri, monacoPositionToMd(position))
    const monacoNs = MonacoLoader.get()
    return locations.map((l) => mdLocationToMonaco(l, monacoNs))
  }
}
