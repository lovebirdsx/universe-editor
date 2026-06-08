/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Monaco language-feature providers for TS/JS — thin shells that forward to the
 *  typescript-language-server (via ITypescriptLanguageService) and convert LSP
 *  results to Monaco shapes. All converters live in lspMonacoConvert.ts; these
 *  classes only bridge Monaco's provider protocol to the service.
 *--------------------------------------------------------------------------------------------*/

import { MonacoLoader, type monaco } from '../../../workbench/editor/monaco/MonacoLoader.js'
import type { ITypescriptLanguageService } from '../../../../shared/ipc/typescriptLanguageService.js'
import {
  applyResolvedCompletion,
  completionListToMonaco,
  definitionToMonaco,
  diagnosticToMarker,
  documentSymbolsToMonaco,
  hoverToMonaco,
  locationsToMonaco,
  monacoPositionToLsp,
  signatureHelpToMonaco,
  workspaceEditToMonaco,
  type MonacoCompletionItem,
} from './lspMonacoConvert.js'

void diagnosticToMarker // re-exported for the sync contribution; referenced to keep the import tree obvious

export class TypescriptDefinitionProvider implements monaco.languages.DefinitionProvider {
  constructor(private readonly _ts: ITypescriptLanguageService) {}

  async provideDefinition(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
  ): Promise<monaco.languages.Definition | monaco.languages.LocationLink[]> {
    const def = await this._ts.provideDefinition(model.uri, monacoPositionToLsp(position))
    return definitionToMonaco(def, MonacoLoader.get())
  }
}

export class TypescriptReferenceProvider implements monaco.languages.ReferenceProvider {
  constructor(private readonly _ts: ITypescriptLanguageService) {}

  async provideReferences(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    context: monaco.languages.ReferenceContext,
  ): Promise<monaco.languages.Location[]> {
    const locs = await this._ts.provideReferences(
      model.uri,
      monacoPositionToLsp(position),
      context.includeDeclaration,
    )
    return locationsToMonaco(locs, MonacoLoader.get())
  }
}

export class TypescriptImplementationProvider implements monaco.languages.ImplementationProvider {
  constructor(private readonly _ts: ITypescriptLanguageService) {}

  async provideImplementation(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
  ): Promise<monaco.languages.Definition | monaco.languages.LocationLink[]> {
    const def = await this._ts.provideImplementation(model.uri, monacoPositionToLsp(position))
    return definitionToMonaco(def, MonacoLoader.get())
  }
}

export class TypescriptTypeDefinitionProvider implements monaco.languages.TypeDefinitionProvider {
  constructor(private readonly _ts: ITypescriptLanguageService) {}

  async provideTypeDefinition(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
  ): Promise<monaco.languages.Definition | monaco.languages.LocationLink[]> {
    const def = await this._ts.provideTypeDefinition(model.uri, monacoPositionToLsp(position))
    return definitionToMonaco(def, MonacoLoader.get())
  }
}

export class TypescriptHoverProvider implements monaco.languages.HoverProvider {
  constructor(private readonly _ts: ITypescriptLanguageService) {}

  async provideHover(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
  ): Promise<monaco.languages.Hover | null> {
    const hover = await this._ts.provideHover(model.uri, monacoPositionToLsp(position))
    return hoverToMonaco(hover)
  }
}

/** Trigger characters mirror VSCode's TS extension. */
const COMPLETION_TRIGGER_CHARACTERS = ['.', '"', "'", '`', '/', '@', '<', '#', ' ']

export class TypescriptCompletionProvider implements monaco.languages.CompletionItemProvider {
  readonly triggerCharacters = COMPLETION_TRIGGER_CHARACTERS

  constructor(private readonly _ts: ITypescriptLanguageService) {}

  async provideCompletionItems(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    context: monaco.languages.CompletionContext,
  ): Promise<monaco.languages.CompletionList> {
    const monacoNs = MonacoLoader.get()
    const word = model.getWordUntilPosition(position)
    const defaultRange: monaco.IRange = {
      startLineNumber: position.lineNumber,
      startColumn: word.startColumn,
      endLineNumber: position.lineNumber,
      endColumn: word.endColumn,
    }
    const result = await this._ts.provideCompletion(model.uri, monacoPositionToLsp(position), {
      // Monaco CompletionTriggerKind (0-based) → LSP (1-based).
      triggerKind: (context.triggerKind + 1) as 1 | 2 | 3,
      ...(context.triggerCharacter ? { triggerCharacter: context.triggerCharacter } : {}),
    })
    return completionListToMonaco(result, defaultRange, monacoNs)
  }

  async resolveCompletionItem(
    item: monaco.languages.CompletionItem,
  ): Promise<monaco.languages.CompletionItem> {
    const monacoItem = item as MonacoCompletionItem
    if (!monacoItem._lspItem) return item
    const resolved = await this._ts.resolveCompletion(monacoItem._lspItem)
    return applyResolvedCompletion(monacoItem, resolved)
  }
}

const SIGNATURE_TRIGGER_CHARACTERS = ['(', ',', '<']
const SIGNATURE_RETRIGGER_CHARACTERS = [')']

export class TypescriptSignatureHelpProvider implements monaco.languages.SignatureHelpProvider {
  readonly signatureHelpTriggerCharacters = SIGNATURE_TRIGGER_CHARACTERS
  readonly signatureHelpRetriggerCharacters = SIGNATURE_RETRIGGER_CHARACTERS

  constructor(private readonly _ts: ITypescriptLanguageService) {}

  async provideSignatureHelp(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    _token: monaco.CancellationToken,
    context: monaco.languages.SignatureHelpContext,
  ): Promise<monaco.languages.SignatureHelpResult | null> {
    const help = await this._ts.provideSignatureHelp(model.uri, monacoPositionToLsp(position), {
      // Monaco and LSP SignatureHelpTriggerKind share the same 1/2/3 values.
      triggerKind: context.triggerKind as 1 | 2 | 3,
      ...(context.triggerCharacter ? { triggerCharacter: context.triggerCharacter } : {}),
      isRetrigger: context.isRetrigger,
    })
    return signatureHelpToMonaco(help)
  }
}

export class TypescriptDocumentSymbolProvider implements monaco.languages.DocumentSymbolProvider {
  constructor(private readonly _ts: ITypescriptLanguageService) {}

  async provideDocumentSymbols(
    model: monaco.editor.ITextModel,
  ): Promise<monaco.languages.DocumentSymbol[]> {
    const symbols = await this._ts.provideDocumentSymbols(model.uri)
    return documentSymbolsToMonaco(symbols)
  }
}

export class TypescriptRenameProvider implements monaco.languages.RenameProvider {
  constructor(private readonly _ts: ITypescriptLanguageService) {}

  async provideRenameEdits(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    newName: string,
  ): Promise<monaco.languages.WorkspaceEdit> {
    const edit = await this._ts.provideRenameEdits(
      model.uri,
      monacoPositionToLsp(position),
      newName,
    )
    return workspaceEditToMonaco(edit, MonacoLoader.get())
  }
}
