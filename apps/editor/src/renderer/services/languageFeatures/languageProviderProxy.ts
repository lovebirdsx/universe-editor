/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Generic Monaco-provider factories whose bodies are serviced by a plugin in the
 *  extension host, addressed by a host-allocated `handle`. Each provider call is
 *  `monacoPositionToLsp` → `extHostLanguages.$provideXxx(handle, …)` → `xxxToMonaco`.
 *  LSP types cross the wire verbatim; all conversion lives in lspMonacoConvert.ts.
 *  MainThreadLanguages picks the right factory per LanguageProviderType.
 *--------------------------------------------------------------------------------------------*/

import type { IExtHostLanguages, ISemanticTokensLegend } from '@universe-editor/extensions-common'
import type { Event } from '@universe-editor/platform'
import { MonacoLoader, type monaco } from '../../workbench/editor/monaco/MonacoLoader.js'
import { PendingDocumentSync } from '../extensions/PendingDocumentSync.js'
import type { IWorkspaceSymbolProvider } from './LanguageFeaturesService.js'
import {
  applyResolvedCompletion,
  codeActionsToMonaco,
  codeLensesToMonaco,
  completionListToMonaco,
  definitionToMonaco,
  documentHighlightsToMonaco,
  documentLinksToMonaco,
  documentSymbolsToMonaco,
  foldingRangesToMonaco,
  hoverToMonaco,
  locationsToMonaco,
  monacoPositionToLsp,
  resolvedCodeLensToMonaco,
  resolvedDocumentLinkToMonaco,
  selectionRangesToMonaco,
  semanticTokensToMonaco,
  signatureHelpToMonaco,
  workspaceEditToMonaco,
  type MonacoCodeLens,
  type MonacoCompletionItem,
  type MonacoDocumentLink,
} from './typescript/lspMonacoConvert.js'

export function createDefinitionProxy(
  handle: number,
  extHost: IExtHostLanguages,
): monaco.languages.DefinitionProvider {
  return {
    provideDefinition: async (model, position) =>
      definitionToMonaco(
        await extHost.$provideDefinition(handle, model.uri, monacoPositionToLsp(position)),
        MonacoLoader.get(),
      ),
  }
}

export function createImplementationProxy(
  handle: number,
  extHost: IExtHostLanguages,
): monaco.languages.ImplementationProvider {
  return {
    provideImplementation: async (model, position) =>
      definitionToMonaco(
        await extHost.$provideImplementation(handle, model.uri, monacoPositionToLsp(position)),
        MonacoLoader.get(),
      ),
  }
}

export function createTypeDefinitionProxy(
  handle: number,
  extHost: IExtHostLanguages,
): monaco.languages.TypeDefinitionProvider {
  return {
    provideTypeDefinition: async (model, position) =>
      definitionToMonaco(
        await extHost.$provideTypeDefinition(handle, model.uri, monacoPositionToLsp(position)),
        MonacoLoader.get(),
      ),
  }
}

export function createReferenceProxy(
  handle: number,
  extHost: IExtHostLanguages,
): monaco.languages.ReferenceProvider {
  return {
    provideReferences: async (model, position, context) =>
      locationsToMonaco(
        await extHost.$provideReferences(handle, model.uri, monacoPositionToLsp(position), {
          includeDeclaration: context.includeDeclaration,
        }),
        MonacoLoader.get(),
      ),
  }
}

export function createHoverProxy(
  handle: number,
  extHost: IExtHostLanguages,
): monaco.languages.HoverProvider {
  return {
    provideHover: async (model, position) =>
      hoverToMonaco(
        await extHost.$provideHover(handle, model.uri, monacoPositionToLsp(position)),
      ) ?? undefined,
  }
}

export function createCompletionProxy(
  handle: number,
  extHost: IExtHostLanguages,
  triggerCharacters: readonly string[],
): monaco.languages.CompletionItemProvider {
  return {
    triggerCharacters: [...triggerCharacters],
    provideCompletionItems: async (model, position, context) => {
      const monacoNs = MonacoLoader.get()
      // Completion fires immediately on a trigger char, ahead of the debounced
      // document sync; flush the just-typed text to the host first or the
      // language service parses a stale line (e.g. no `#` yet → no headers).
      await PendingDocumentSync.flush(model.uri.toString())
      const word = model.getWordUntilPosition(position)
      const defaultRange: monaco.IRange = {
        startLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: word.endColumn,
      }
      const result = await extHost.$provideCompletion(
        handle,
        model.uri,
        monacoPositionToLsp(position),
        {
          // Monaco CompletionTriggerKind (0-based) → LSP (1-based).
          triggerKind: (context.triggerKind + 1) as 1 | 2 | 3,
          ...(context.triggerCharacter ? { triggerCharacter: context.triggerCharacter } : {}),
        },
      )
      return completionListToMonaco(result, defaultRange, monacoNs)
    },
    resolveCompletionItem: async (item) => {
      const monacoItem = item as MonacoCompletionItem
      if (!monacoItem._lspItem) return item
      const resolved = await extHost.$resolveCompletionItem(handle, monacoItem._lspItem)
      return applyResolvedCompletion(monacoItem, resolved)
    },
  }
}

export function createSignatureHelpProxy(
  handle: number,
  extHost: IExtHostLanguages,
  triggerCharacters: readonly string[],
  retriggerCharacters: readonly string[],
): monaco.languages.SignatureHelpProvider {
  return {
    signatureHelpTriggerCharacters: [...triggerCharacters],
    signatureHelpRetriggerCharacters: [...retriggerCharacters],
    provideSignatureHelp: async (model, position, _token, context) =>
      signatureHelpToMonaco(
        await extHost.$provideSignatureHelp(handle, model.uri, monacoPositionToLsp(position), {
          // Monaco and LSP SignatureHelpTriggerKind share the same 1/2/3 values.
          triggerKind: context.triggerKind as 1 | 2 | 3,
          ...(context.triggerCharacter ? { triggerCharacter: context.triggerCharacter } : {}),
          isRetrigger: context.isRetrigger,
        }),
      ),
  }
}

export function createDocumentSymbolProxy(
  handle: number,
  extHost: IExtHostLanguages,
): monaco.languages.DocumentSymbolProvider {
  return {
    provideDocumentSymbols: async (model) =>
      documentSymbolsToMonaco(await extHost.$provideDocumentSymbols(handle, model.uri)),
  }
}

export function createRenameProxy(
  handle: number,
  extHost: IExtHostLanguages,
): monaco.languages.RenameProvider {
  return {
    provideRenameEdits: async (model, position, newName) =>
      workspaceEditToMonaco(
        await extHost.$provideRenameEdits(
          handle,
          model.uri,
          monacoPositionToLsp(position),
          newName,
        ),
        MonacoLoader.get(),
      ),
  }
}

export function createWorkspaceSymbolProxy(
  handle: number,
  extHost: IExtHostLanguages,
): IWorkspaceSymbolProvider {
  return {
    provideWorkspaceSymbols: (query) => extHost.$provideWorkspaceSymbols(handle, query),
  }
}

export function createFoldingRangeProxy(
  handle: number,
  extHost: IExtHostLanguages,
): monaco.languages.FoldingRangeProvider {
  return {
    provideFoldingRanges: async (model) =>
      foldingRangesToMonaco(
        await extHost.$provideFoldingRanges(handle, model.uri),
        MonacoLoader.get(),
      ),
  }
}

export function createDocumentLinkProxy(
  handle: number,
  extHost: IExtHostLanguages,
): monaco.languages.LinkProvider {
  return {
    provideLinks: async (model) =>
      documentLinksToMonaco(
        await extHost.$provideDocumentLinks(handle, model.uri),
        MonacoLoader.get(),
      ),
    resolveLink: async (link) => {
      const monacoLink = link as MonacoDocumentLink
      if (!monacoLink._lspLink) return link
      return resolvedDocumentLinkToMonaco(
        await extHost.$resolveDocumentLink(handle, monacoLink._lspLink),
        link,
        MonacoLoader.get(),
      )
    },
  }
}

export function createDocumentHighlightProxy(
  handle: number,
  extHost: IExtHostLanguages,
): monaco.languages.DocumentHighlightProvider {
  return {
    provideDocumentHighlights: async (model, position) =>
      documentHighlightsToMonaco(
        await extHost.$provideDocumentHighlights(handle, model.uri, monacoPositionToLsp(position)),
      ),
  }
}

export function createSelectionRangeProxy(
  handle: number,
  extHost: IExtHostLanguages,
): monaco.languages.SelectionRangeProvider {
  return {
    provideSelectionRanges: async (model, positions) =>
      selectionRangesToMonaco(
        await extHost.$provideSelectionRanges(
          handle,
          model.uri,
          positions.map(monacoPositionToLsp),
        ),
      ),
  }
}

export function createCodeActionProxy(
  handle: number,
  extHost: IExtHostLanguages,
): monaco.languages.CodeActionProvider {
  return {
    provideCodeActions: async (model, range, context) =>
      codeActionsToMonaco(
        await extHost.$provideCodeActions(
          handle,
          model.uri,
          {
            start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
            end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
          },
          { ...(context.only ? { only: [context.only] } : {}) },
        ),
        MonacoLoader.get(),
      ),
  }
}

export function createDocumentSemanticTokensProxy(
  handle: number,
  extHost: IExtHostLanguages,
  legend: ISemanticTokensLegend,
): monaco.languages.DocumentSemanticTokensProvider {
  return {
    getLegend: () => ({
      tokenTypes: [...legend.tokenTypes],
      tokenModifiers: [...legend.tokenModifiers],
    }),
    provideDocumentSemanticTokens: async (model) =>
      semanticTokensToMonaco(await extHost.$provideDocumentSemanticTokens(handle, model.uri)),
    // Monaco requires the method; the token stream carries no server-side handle
    // to release (tsserver full-tokens have no lifecycle), so this is a no-op.
    releaseDocumentSemanticTokens: () => undefined,
  }
}

export function createCodeLensProxy(
  handle: number,
  extHost: IExtHostLanguages,
  onDidChange: Event<void>,
): monaco.languages.CodeLensProvider {
  // Monaco types onDidChange as IEvent<this> (the listener receives the provider),
  // but its CodeLens controller ignores the argument and just re-requests on any
  // fire, so a value-less Event drives the refresh correctly. Cast through unknown
  // since the two Event shapes don't structurally overlap.
  const onDidChangeCodeLenses = onDidChange as unknown as NonNullable<
    monaco.languages.CodeLensProvider['onDidChange']
  >
  return {
    onDidChange: onDidChangeCodeLenses,
    provideCodeLenses: async (model) =>
      codeLensesToMonaco(await extHost.$provideCodeLenses(handle, model.uri), MonacoLoader.get()),
    resolveCodeLens: async (_model, codeLens) => {
      const monacoLens = codeLens as MonacoCodeLens
      if (!monacoLens._lspLens) return codeLens
      return resolvedCodeLensToMonaco(
        await extHost.$resolveCodeLens(handle, monacoLens._lspLens),
        codeLens,
        MonacoLoader.get(),
      )
    },
  }
}
