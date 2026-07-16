/*
 * Excel viewer & diff for Universe Editor. Registers a custom editor for
 * spreadsheet files. Opened on a single file → renders that workbook. Opened as a
 * webview diff (via `_workbench.openWebviewDiff`, e.g. from the Explorer compare
 * commands or Git/Perforce version comparison) → renders a side-by-side diff.
 *
 * Parsing (SheetJS) + diff computation run here in the extension, where the raw
 * bytes arrive; the webview is a thin painter fed a JSON model over the initial
 * HTML. The heavy SheetJS dependency is bundled into this node extension rather
 * than shipped as a browser build.
 */
import {
  window,
  workspace,
  type CustomDocument,
  type ExtensionContext,
  type UriComponents,
  type Webview,
  type WebviewPanel,
} from '@universe-editor/extension-api'
import viewerHtml from '../assets/viewer.html'
import { parseWorkbook, type WorkbookModel } from './parse.js'
import { diffWorkbooks } from './diff.js'

const VIEW_TYPE = 'universe.excel'

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

/** Basename of a UriComponents path, for labels. */
function basename(uri: UriComponents): string {
  const p = uri.path ?? ''
  const slash = p.lastIndexOf('/')
  return slash >= 0 ? p.slice(slash + 1) : p
}

/** Embed a JSON payload in a `<script type="application/json">` safely: the block
 *  is read via `textContent` + `JSON.parse` (not evaluated), so only the `<`/`&`
 *  that could break out of the element need escaping. */
function escapeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/&/g, '\\u0026')
}

/** UriComponents (file scheme) → an OS filesystem path the gated fs accepts. */
function uri2fsPath(uri: UriComponents): string {
  const p = uri.path ?? ''
  // On Windows a `file:` path is `/C:/...`; strip the leading slash.
  return /^\/[A-Za-z]:\//.test(p) ? p.slice(1) : p
}

class SpreadsheetDocument implements CustomDocument {
  constructor(readonly uri: UriComponents) {}
  dispose(): void {}
}

export function activate(context: ExtensionContext): void {
  const extensionRoot = context.extensionPath

  const asset = (webview: Webview, ...segments: string[]): string =>
    webview.asWebviewUri(fileUri(joinPath(extensionRoot, 'assets', ...segments)))

  const buildHtml = (webview: Webview, payload: unknown, docDir?: UriComponents): string => {
    const cspSource = webview.cspSource
    const roots: UriComponents[] = [fileUri(extensionRoot)]
    if (docDir) roots.push(docDir)
    webview.options = { enableScripts: true, localResourceRoots: roots }

    return viewerHtml
      .replace(
        '<!--HEAD-->',
        `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' ${cspSource}; style-src 'unsafe-inline' ${cspSource}; font-src ${cspSource}; img-src ${cspSource} data:;">
<link rel="stylesheet" href="${asset(webview, 'viewer.css')}">`,
      )
      .replace(
        '<!--BODY_SCRIPT-->',
        `<script id="excel-payload" type="application/json">${escapeJsonForScript(payload)}</script>
<script src="${asset(webview, 'viewer.mjs')}" type="module"></script>`,
      )
  }

  const provider = {
    openCustomDocument(uri: UriComponents): SpreadsheetDocument {
      return new SpreadsheetDocument(uri)
    },
    async resolveCustomEditor(document: SpreadsheetDocument, panel: WebviewPanel): Promise<void> {
      const diff = panel.diffContext
      try {
        if (diff) {
          const left = parseWorkbook(diff.left)
          const right = parseWorkbook(diff.right)
          panel.webview.html = buildHtml(panel.webview, {
            mode: 'diff',
            title: diff.title,
            leftLabel: basename(diff.leftUri),
            rightLabel: basename(diff.rightUri),
            diff: diffWorkbooks(left, right),
          })
          return
        }
        const bytes = await workspace.fs.readFile(uri2fsPath(document.uri))
        const workbook: WorkbookModel = parseWorkbook(bytes)
        panel.webview.html = buildHtml(
          panel.webview,
          { mode: 'view', title: basename(document.uri), workbook },
          dirUri(document.uri),
        )
      } catch (err) {
        panel.webview.html = buildHtml(panel.webview, {
          mode: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }

  context.subscriptions.push(
    window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      supportsMultipleEditorsPerDocument: false,
    }),
  )
}

export function deactivate(): void {}
