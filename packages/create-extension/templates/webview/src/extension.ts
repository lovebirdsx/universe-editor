/*
 * Minimal read-only custom editor, in the shape of the built-in PDF viewer:
 * open a `*.__name__` file and this extension renders it in a webview. The
 * webview runs with scripts disabled — flip `enableScripts` when your preview
 * needs them (and keep the CSP + localResourceRoots discipline from the
 * webview guide). The preview logic lives in preview.ts so it stays
 * unit-testable without the extension API.
 */
import {
  window,
  type ExtensionContext,
  type UriComponents,
  type WebviewPanel,
} from '@universe-editor/extension-api'
import { PreviewDocument, dirUri, fileUri, joinPath, renderHtml } from './preview.js'

const VIEW_TYPE = '__name__.preview'

export function activate(context: ExtensionContext): void {
  const extensionRoot = context.extensionPath

  const provider = {
    openCustomDocument(uri: UriComponents): PreviewDocument {
      return new PreviewDocument(uri)
    },
    resolveCustomEditor(document: PreviewDocument, panel: WebviewPanel): void {
      panel.webview.options = {
        enableScripts: false,
        // The extension dir holds preview assets; the document's own folder
        // must be allow-listed too so asWebviewUri(document.uri) resolves.
        localResourceRoots: [fileUri(joinPath(extensionRoot)), dirUri(document.uri)],
      }
      panel.webview.html = renderHtml(document)
    },
  }

  context.subscriptions.push(
    window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      supportsMultipleEditorsPerDocument: false,
    }),
  )
}

export function deactivate(): void {}
