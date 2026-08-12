/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Generic Monaco-provider factories whose bodies are serviced by a plugin in the
 *  extension host, addressed by a host-allocated `handle`. Each provider call is
 *  `monacoPositionToLsp` → `extHostLanguages.$provideXxx(handle, …)` → `xxxToMonaco`.
 *  LSP types cross the wire verbatim; all conversion lives in lspMonacoConvert.ts.
 *  MainThreadLanguages picks the right factory per LanguageProviderType.
 *--------------------------------------------------------------------------------------------*/

import type { IExtHostLanguages, ISemanticTokensLegend } from '@universe-editor/extensions-common'
import type { DisposableStore, Event } from '@universe-editor/platform'
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
  inlayHintsToMonaco,
  locationsToMonaco,
  monacoPositionToLsp,
  monacoRangeToLsp,
  resolvedCodeLensToMonaco,
  resolvedDocumentLinkToMonaco,
  resolvedInlayHintToMonaco,
  selectionRangesToMonaco,
  semanticTokensToMonaco,
  signatureHelpToMonaco,
  textEditsToMonaco,
  workspaceEditToMonaco,
  type MonacoCodeLens,
  type MonacoCompletionItem,
  type MonacoDocumentLink,
  type MonacoInlayHint,
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

const PULL_CACHE_MAX_URIS = 8

/**
 * Version-keyed pull cache at the wire boundary. Symbol/lens payloads for a
 * large file are multi-MB JSON frames, and every consumer that re-attaches a
 * model (tab switch → sticky scroll, outline, breadcrumbs, codelens) re-pulls
 * them — decoding the same frame repeatedly stalls the renderer main thread.
 * Sharing one in-flight/settled promise per (uri, model version) makes a
 * switch back to an unchanged file wire-free. Empty and rejected results are
 * never cached: providers legitimately return [] while their backing server
 * is still starting, and consumers retry expecting a fresh pull.
 */
function createVersionedPullCache<T>(isEmpty: (value: T) => boolean) {
  const cache = new Map<string, { versionId: number; promise: Promise<T> }>()
  const pull = (model: monaco.editor.ITextModel, run: () => Promise<T>): Promise<T> => {
    const key = model.uri.toString()
    const versionId = model.getVersionId()
    const hit = cache.get(key)
    if (hit && hit.versionId === versionId) {
      cache.delete(key)
      cache.set(key, hit)
      return hit.promise
    }
    const promise = run()
    cache.delete(key)
    cache.set(key, { versionId, promise })
    promise.then(
      (value) => {
        if (isEmpty(value) && cache.get(key)?.promise === promise) cache.delete(key)
      },
      () => {
        if (cache.get(key)?.promise === promise) cache.delete(key)
      },
    )
    if (cache.size > PULL_CACHE_MAX_URIS) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    return promise
  }
  return { pull, clear: () => cache.clear() }
}

export function createDocumentSymbolProxy(
  handle: number,
  extHost: IExtHostLanguages,
): monaco.languages.DocumentSymbolProvider {
  const cache = createVersionedPullCache<monaco.languages.DocumentSymbol[]>((v) => v.length === 0)
  return {
    provideDocumentSymbols: (model) =>
      cache.pull(model, async () =>
        documentSymbolsToMonaco(await extHost.$provideDocumentSymbols(handle, model.uri)),
      ),
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
    provideWorkspaceSymbols: (query, token) => {
      // The RPC layer can't carry a CancellationToken, so cancellation rides a
      // side channel: the host cancels the in-flight query for this handle.
      const sub = token.onCancellationRequested(() => {
        extHost.$cancelWorkspaceSymbols(handle)
      })
      return extHost.$provideWorkspaceSymbols(handle, query).finally(() => sub.dispose())
    },
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
        await extHost.$provideCodeActions(handle, model.uri, monacoRangeToLsp(range), {
          ...(context.only ? { only: [context.only] } : {}),
        }),
        MonacoLoader.get(),
      ),
  }
}

export function createDocumentFormattingProxy(
  handle: number,
  extHost: IExtHostLanguages,
): monaco.languages.DocumentFormattingEditProvider {
  return {
    provideDocumentFormattingEdits: async (model, options) =>
      textEditsToMonaco(
        await extHost.$provideDocumentFormattingEdits(handle, model.uri, {
          tabSize: options.tabSize,
          insertSpaces: options.insertSpaces,
        }),
      ),
  }
}

export function createDocumentRangeFormattingProxy(
  handle: number,
  extHost: IExtHostLanguages,
): monaco.languages.DocumentRangeFormattingEditProvider {
  return {
    provideDocumentRangeFormattingEdits: async (model, range, options) =>
      textEditsToMonaco(
        await extHost.$provideDocumentRangeFormattingEdits(
          handle,
          model.uri,
          monacoRangeToLsp(range),
          { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
        ),
      ),
  }
}

export function createOnTypeFormattingProxy(
  handle: number,
  extHost: IExtHostLanguages,
  triggerCharacters: readonly string[],
): monaco.languages.OnTypeFormattingEditProvider {
  return {
    autoFormatTriggerCharacters: [...triggerCharacters],
    provideOnTypeFormattingEdits: async (model, position, ch, options) =>
      textEditsToMonaco(
        await extHost.$provideOnTypeFormattingEdits(
          handle,
          model.uri,
          monacoPositionToLsp(position),
          ch,
          { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
        ),
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
  store: DisposableStore,
): monaco.languages.CodeLensProvider {
  // Monaco types onDidChange as IEvent<this> (the listener receives the provider),
  // but its CodeLens controller ignores the argument and just re-requests on any
  // fire, so a value-less Event drives the refresh correctly. Cast through unknown
  // since the two Event shapes don't structurally overlap.
  const onDidChangeCodeLenses = onDidChange as unknown as NonNullable<
    monaco.languages.CodeLensProvider['onDidChange']
  >
  const cache = createVersionedPullCache<monaco.languages.CodeLensList>(
    (v) => v.lenses.length === 0,
  )
  // The host fires onDidChange when lens data (e.g. reference counts) changed
  // without a document edit — the version key alone would serve stale lenses.
  store.add(onDidChange(() => cache.clear()))
  return {
    onDidChange: onDidChangeCodeLenses,
    provideCodeLenses: (model) =>
      cache.pull(model, async () =>
        codeLensesToMonaco(await extHost.$provideCodeLenses(handle, model.uri), MonacoLoader.get()),
      ),
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

export function createInlayHintsProxy(
  handle: number,
  extHost: IExtHostLanguages,
  onDidChange: Event<void>,
  supportsResolve: boolean,
): monaco.languages.InlayHintsProvider {
  const provider: monaco.languages.InlayHintsProvider = {
    onDidChangeInlayHints: onDidChange,
    provideInlayHints: async (model, range) =>
      inlayHintsToMonaco(
        await extHost.$provideInlayHints(handle, model.uri, monacoRangeToLsp(range)),
        MonacoLoader.get(),
      ),
  }
  // Only attach resolveInlayHint when the extension provider implements it —
  // otherwise Monaco would round-trip every visible hint for nothing.
  if (supportsResolve) {
    provider.resolveInlayHint = async (hint) => {
      const monacoHint = hint as MonacoInlayHint
      if (monacoHint._resolveCacheId === undefined || monacoHint._resolveIndex === undefined) {
        return hint
      }
      return resolvedInlayHintToMonaco(
        await extHost.$resolveInlayHint(
          handle,
          monacoHint._resolveCacheId,
          monacoHint._resolveIndex,
        ),
        hint,
        MonacoLoader.get(),
      )
    }
  }
  return provider
}
