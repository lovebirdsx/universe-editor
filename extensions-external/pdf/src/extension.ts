/*
 * PDF viewer for Universe Editor — ported from vscode-pdf (Mathematic Inc,
 * Apache-2.0) to the `@universe-editor/extension-api` custom-editor surface.
 *
 * Renders a `.pdf` in a webview via Mozilla's pdf.js. The extension serves its
 * bundled pdf.js assets to the webview through `asWebviewUri` (the assets live
 * under the extension directory, which the host allow-lists for us).
 */
import {
  Uri,
  window,
  workspace,
  type CustomDocument,
  type ExtensionContext,
  type UriComponents,
  type Webview,
  type WebviewPanel,
} from '@universe-editor/extension-api'

// Inlined at build time by esbuild's `text` loader (see esbuild.config.mjs).
import rawViewerHtml from '../assets/pdf.js/web/viewer.html'

const VIEW_TYPE = 'pdf.view'

// Strip the tags the upstream viewer.html hard-codes; we re-inject them with
// asWebviewUri'd URLs so the sandboxed webview can actually load them.
const viewerHtml = rawViewerHtml
  .replace(`<link rel="resource" type="application/l10n" href="locale/locale.json">`, '')
  .replace(`<script src="../build/pdf.mjs" type="module"></script>`, '')
  .replace(`<script src="viewer.mjs" type="module"></script>`, '')
  .replace(`<link rel="stylesheet" href="viewer.css">`, '')

function escapeAttribute(value: unknown): string {
  return JSON.stringify(value).replace(/"/g, '&quot;')
}

/** Join POSIX-style path segments onto an extension-relative path. */
function joinPath(base: string, ...segments: string[]): string {
  return [base.replace(/[\\/]+$/, ''), ...segments].join('/')
}

/** Build a `file:` UriComponents for an extension-relative resource. */
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

class PdfDocument implements CustomDocument {
  constructor(readonly uri: UriComponents) {}
  dispose(): void {
    // The per-panel file watcher is tied to the panel in resolveCustomEditor.
  }
}

export function activate(context: ExtensionContext): void {
  const extensionRoot = context.extensionPath

  const asset = (webview: Webview, ...segments: string[]): string =>
    webview.asWebviewUri(fileUri(joinPath(extensionRoot, 'assets', ...segments)))

  const buildHtml = (webview: Webview, resource: UriComponents): string => {
    const cspSource = webview.cspSource
    const docUrl = webview.asWebviewUri(resource)
    const config = {
      url: docUrl,
      docBaseUrl: docUrl,
      defaultZoomValue: 'auto',
      sidebarViewOnLoad: 0,
    }

    return viewerHtml
      .replace(
        '<title>PDF.js viewer</title>',
        `
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${cspSource}; script-src 'unsafe-inline' ${cspSource}; worker-src blob: ${cspSource}; style-src 'unsafe-inline' ${cspSource}; img-src * ${cspSource} data:; font-src ${cspSource};">
<meta id="pdf-view-config" data-config="${escapeAttribute(config)}">

<title>PDF.js viewer</title>

<link rel="stylesheet" href="${asset(webview, 'pdf.js', 'web', 'viewer.css')}">
<link rel="stylesheet" href="${asset(webview, 'main.css')}">

<script src="${asset(webview, 'pdf.js', 'build', 'pdf.mjs')}" type="module"></script>
<script src="${asset(webview, 'main.mjs')}" type="module"></script>

<link rel="resource" type="application/l10n" href="${asset(webview, 'pdf.js', 'web', 'locale', 'locale.json')}">`,
      )
      .trim()
  }

  const provider = {
    openCustomDocument(uri: UriComponents): PdfDocument {
      return new PdfDocument(uri)
    },
    resolveCustomEditor(document: PdfDocument, panel: WebviewPanel): void {
      panel.webview.options = {
        enableScripts: true,
        // The extension dir holds pdf.js; the document's own folder must be
        // allow-listed too so `asWebviewUri(document.uri)` resolves.
        localResourceRoots: [fileUri(extensionRoot), dirUri(document.uri)],
      }
      panel.webview.html = buildHtml(panel.webview, document.uri)

      // Reload the preview when the pdf changes on disk. A glob-free absolute
      // path watches exactly this file (also outside the workspace).
      const watcher = workspace.createFileSystemWatcher(
        Uri.from(document.uri).fsPath,
        true,
        false,
        true,
      )
      const subscription = watcher.onDidChange(() => {
        void panel.webview.postMessage({ action: 'reload' })
      })
      panel.onDidDispose(() => {
        subscription.dispose()
        watcher.dispose()
      })
    },
  }

  context.subscriptions.push(
    window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      supportsMultipleEditorsPerDocument: false,
    }),
  )
}

export function deactivate(): void {
  // noop
}
