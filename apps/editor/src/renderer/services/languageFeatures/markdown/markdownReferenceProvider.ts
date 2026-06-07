/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ReferenceProvider for markdown — a thin shell that forwards to the markdown
 *  language server. With the cursor on a heading, finds every link across the
 *  workspace that points at it (Shift+F12).
 *--------------------------------------------------------------------------------------------*/

import { MonacoLoader, type monaco } from '../../../workbench/editor/monaco/MonacoLoader.js'
import type { IMarkdownLanguageService } from '../../../../shared/ipc/markdownLanguageService.js'
import { mdLocationToMonaco, monacoPositionToMd } from './lspMonacoConvert.js'

export class MarkdownReferenceProvider implements monaco.languages.ReferenceProvider {
  constructor(private readonly _md: IMarkdownLanguageService) {}

  async provideReferences(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    context: monaco.languages.ReferenceContext,
  ): Promise<monaco.languages.Location[]> {
    const locations = await this._md.provideReferences(
      model.uri,
      monacoPositionToMd(position),
      context.includeDeclaration,
    )
    const monacoNs = MonacoLoader.get()
    return locations.map((l) => mdLocationToMonaco(l, monacoNs))
  }
}
