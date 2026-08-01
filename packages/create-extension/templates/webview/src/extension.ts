/*
 * Minimal read-only custom editor, in the shape of the built-in PDF viewer:
 * open a `*.__name__` file and this extension renders it in a webview. The
 * webview runs with scripts disabled — flip `enableScripts` when your preview
 * needs them (and keep the CSP + localResourceRoots discipline from the
 * webview guide).
 */
import {
  window,
  type CustomDocument,
  type ExtensionContext,
  type UriComponents,
  type WebviewPanel,
} from '@universe-editor/extension-api'

const VIEW_TYPE = '__name__.preview'

/** Join POSIX-style path segments onto a base path. */
function joinPath(base: string, ...segments: string[]): string {
  return [base.replace(/[\\/]+$/, ''), ...segments].join('/')
}

/** Build a `file:` UriComponents for an absolute filesystem path. */
function fileUri(fsPath: string): UriComponents {
  const forward = fsPath.replace(/\\/g, '/')
  return { scheme: 'file', path: forward.startsWith('/') ? forward : `/${forward}` }
}

/** The directory portion of a `file:` UriComponents, as a `file:` UriComponents. */
function dirUri(uri: UriComponents): UriComponents {
  const p = uri.path ?? ''
  const slash = p.lastIndexOf('/')
  return { scheme: 'file', path: slash > 0 ? p.slice(0, slash) : '/' }
}

class PreviewDocument implements CustomDocument {
  constructor(readonly uri: UriComponents) {}
  dispose(): void {
    // Nothing held — see the PDF sample for when a document needs cleanup.
  }
}

function renderHtml(document: PreviewDocument): string {
  const fileName = document.uri.path?.split('/').pop() ?? ''
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <title>__displayName__ Preview</title>
    <style>
      body { font-family: system-ui, sans-serif; padding: 2rem; }
      code { background: rgba(127, 127, 127, 0.2); padding: 0.1em 0.3em; border-radius: 3px; }
    </style>
  </head>
  <body>
    <h1>__displayName__</h1>
    <p>Previewing <code>${fileName}</code>.</p>
    <p>Replace this static HTML with your own renderer.</p>
  </body>
</html>`
}

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
