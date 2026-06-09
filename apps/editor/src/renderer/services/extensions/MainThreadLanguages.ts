/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side handler for the host → renderer `mainThreadLanguages` channel.
 *  A plugin registers language providers (addressed by a host-allocated handle);
 *  here we build the matching Monaco provider shell per LanguageProviderType, wire
 *  it into ILanguageFeaturesService, and track handle → disposable for teardown.
 *  Diagnostics published by a plugin land as Monaco markers keyed by `owner`.
 *--------------------------------------------------------------------------------------------*/

import {
  DisposableStore,
  URI,
  type IDisposable,
  type UriComponents,
} from '@universe-editor/platform'
import type {
  DocumentSelector,
  IExtHostLanguages,
  ILanguageProviderMetadata,
  IMainThreadLanguages,
  LanguageProviderType,
} from '@universe-editor/extensions-common'
import type { Diagnostic } from 'vscode-languageserver-types'
import { MonacoLoader } from '../../workbench/editor/monaco/MonacoLoader.js'
import { MonacoModelRegistry } from '../../workbench/editor/monaco/MonacoModelRegistry.js'
import { diagnosticToMarker } from '../languageFeatures/typescript/lspMonacoConvert.js'
import type { ILanguageFeaturesService } from '../languageFeatures/LanguageFeaturesService.js'
import {
  createCompletionProxy,
  createDefinitionProxy,
  createDocumentSymbolProxy,
  createHoverProxy,
  createImplementationProxy,
  createReferenceProxy,
  createRenameProxy,
  createSignatureHelpProxy,
  createTypeDefinitionProxy,
  createWorkspaceSymbolProxy,
} from '../languageFeatures/languageProviderProxy.js'

export class MainThreadLanguages implements IMainThreadLanguages {
  private readonly _providers = new Map<number, IDisposable>()

  constructor(
    private readonly _extHost: IExtHostLanguages,
    private readonly _languageFeatures: ILanguageFeaturesService,
  ) {}

  $registerProvider(
    handle: number,
    type: LanguageProviderType,
    selector: DocumentSelector,
    metadata?: ILanguageProviderMetadata,
  ): Promise<void> {
    this._providers.get(handle)?.dispose()
    this._providers.set(handle, this._register(handle, type, selector, metadata))
    return Promise.resolve()
  }

  $unregisterProvider(handle: number): Promise<void> {
    this._providers.get(handle)?.dispose()
    this._providers.delete(handle)
    return Promise.resolve()
  }

  $publishDiagnostics(
    owner: string,
    uri: UriComponents,
    diagnostics: readonly Diagnostic[],
  ): Promise<void> {
    this._setMarkers(owner, uri, diagnostics)
    return Promise.resolve()
  }

  $clearDiagnostics(owner: string, uri?: UriComponents): Promise<void> {
    if (uri) this._setMarkers(owner, uri, [])
    else MonacoLoader.get().editor.removeAllMarkers(owner)
    return Promise.resolve()
  }

  private _register(
    handle: number,
    type: LanguageProviderType,
    selector: DocumentSelector,
    metadata: ILanguageProviderMetadata | undefined,
  ): IDisposable {
    const lf = this._languageFeatures
    const ext = this._extHost
    const store = new DisposableStore()

    switch (type) {
      case 'definition': {
        const p = createDefinitionProxy(handle, ext)
        for (const lang of selector) store.add(lf.registerDefinitionProvider(lang, p))
        break
      }
      case 'references': {
        const p = createReferenceProxy(handle, ext)
        for (const lang of selector) store.add(lf.registerReferenceProvider(lang, p))
        break
      }
      case 'implementation': {
        const p = createImplementationProxy(handle, ext)
        for (const lang of selector) store.add(lf.registerImplementationProvider(lang, p))
        break
      }
      case 'typeDefinition': {
        const p = createTypeDefinitionProxy(handle, ext)
        for (const lang of selector) store.add(lf.registerTypeDefinitionProvider(lang, p))
        break
      }
      case 'hover': {
        const p = createHoverProxy(handle, ext)
        for (const lang of selector) store.add(lf.registerHoverProvider(lang, p))
        break
      }
      case 'completion': {
        const p = createCompletionProxy(handle, ext, metadata?.triggerCharacters ?? [])
        for (const lang of selector) store.add(lf.registerCompletionProvider(lang, p))
        break
      }
      case 'signatureHelp': {
        const p = createSignatureHelpProxy(
          handle,
          ext,
          metadata?.signatureHelpTriggerCharacters ?? [],
          metadata?.signatureHelpRetriggerCharacters ?? [],
        )
        for (const lang of selector) store.add(lf.registerSignatureHelpProvider(lang, p))
        break
      }
      case 'documentSymbol': {
        const p = createDocumentSymbolProxy(handle, ext)
        for (const lang of selector) store.add(lf.registerDocumentSymbolProvider(lang, p))
        break
      }
      case 'rename': {
        const p = createRenameProxy(handle, ext)
        for (const lang of selector) store.add(lf.registerRenameProvider(lang, p))
        break
      }
      case 'workspaceSymbol': {
        store.add(lf.registerWorkspaceSymbolProvider(createWorkspaceSymbolProxy(handle, ext)))
        break
      }
    }
    return store
  }

  private _setMarkers(owner: string, uri: UriComponents, diagnostics: readonly Diagnostic[]): void {
    const resource = URI.revive(uri)
    if (!resource) return
    const model = MonacoModelRegistry.peek(resource)
    if (!model || model.isDisposed()) return
    const monacoNs = MonacoLoader.get()
    monacoNs.editor.setModelMarkers(
      model,
      owner,
      diagnostics.map((d) => diagnosticToMarker(d, monacoNs)),
    )
  }
}
